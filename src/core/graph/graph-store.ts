/**
 * Entity-Graph Store (Graphiti-style, lazy edition).
 *
 * Temporal entity/edge store on the same node:sqlite database used by the
 * vector store. Graphiti principles implemented:
 *  - under-merge over over-merge: entity resolution matches by exact
 *    canonical key (name after normalization) + user scope; ambiguous
 *    mentions create NEW nodes rather than merging.
 *  - ADD-only facts: contradictions invalidate older facts (invalid_at set),
 *    nothing is deleted.
 *  - per-user scoping via user_id column (actorId from gateway).
 *
 * ponytail: exact-name resolution only (no fuzzy embedding match yet) —
 * upgrade path: add embedding column + vector match when alias drift hurts.
 */

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

export interface EntityNode {
  id: number;
  userId: string;
  name: string;        // canonical name, normalized
  type: string;        // person | project | tool | concept | ...
  summary?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EntityEdge {
  id: number;
  userId: string;
  sourceId: number;
  targetId: number;
  fact: string;        // "Искандер любит coldwave"
  validFrom: number;
  validTo?: number | null; // null = currently valid (ADD-only: invalidated, not deleted)
  episodeId?: string | null;
  createdAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS eg_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'concept',
  summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS eg_entities_user ON eg_entities(user_id);

CREATE TABLE IF NOT EXISTS eg_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  source_id INTEGER NOT NULL REFERENCES eg_entities(id),
  target_id INTEGER NOT NULL REFERENCES eg_entities(id),
  fact TEXT NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  episode_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS eg_edges_user ON eg_edges(user_id);
CREATE INDEX IF NOT EXISTS eg_edges_src ON eg_edges(source_id);
CREATE INDEX IF NOT EXISTS eg_edges_tgt ON eg_edges(target_id);
`;

export class EntityGraphStore {
  private db: any;

  constructor(dbPath: string) {
    const DbSync = require("node:sqlite").DatabaseSync;
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DbSync(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  /** Find or create entity by normalized name (exact match = under-merge). */
  resolve(userId: string, name: string, type: string): number {
    const norm = name.trim().toLowerCase();
    const existing = this.db
      .prepare("SELECT id FROM eg_entities WHERE user_id = ? AND name = ?")
      .get(userId, norm);
    if (existing) return existing.id;
    const now = Date.now();
    const res = this.db
      .prepare(
        "INSERT INTO eg_entities (user_id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(userId, norm, type, now, now);
    return Number(res.lastInsertRowid);
  }

  /** ADD-only fact: if it contradicts a currently-valid edge with same endpoints, invalidate the old one. */
  addFact(
    userId: string,
    sourceId: number,
    targetId: number,
    fact: string,
    episodeId?: string,
  ): { added: boolean; invalidated: number } {
    const now = Date.now();
    // Dedup first: exact same fact still valid → no-op (ADD-only idempotency).
    const dup = this.db
      .prepare(
        `SELECT 1 FROM eg_edges WHERE user_id = ? AND source_id = ? AND target_id = ? AND fact = ? AND valid_to IS NULL`,
      )
      .get(userId, sourceId, targetId, fact);
    if (dup) return { added: false, invalidated: 0 };
    // Contradiction: same endpoints, different fact, still valid → invalidate old.
    const inv = this.db
      .prepare(
        `UPDATE eg_edges SET valid_to = ? WHERE user_id = ? AND source_id = ? AND target_id = ?
         AND valid_to IS NULL AND fact != ?`,
      )
      .run(now, userId, sourceId, targetId, fact);
    const invalidated = inv.changes;
    this.db
      .prepare(
        `INSERT INTO eg_edges (user_id, source_id, target_id, fact, valid_from, episode_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(userId, sourceId, targetId, fact, now, episodeId ?? null, now);
    return { added: true, invalidated };
  }

  /** Currently-valid edges touching any of the given entity ids. */
  validEdgesFor(userId: string, entityIds: number[], limit = 20): EntityEdge[] {
    if (entityIds.length === 0) return [];
    const placeholders = entityIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT id, source_id, target_id, fact, valid_from, valid_to, episode_id, created_at
         FROM eg_edges WHERE user_id = ? AND valid_to IS NULL
         AND (source_id IN (${placeholders}) OR target_id IN (${placeholders}))
         LIMIT ?`,
      )
      .all(userId, ...entityIds, ...entityIds, limit);
    return rows.map(r => ({
      id: r.id, userId, sourceId: r.source_id, targetId: r.target_id,
      fact: r.fact, validFrom: r.valid_from, validTo: r.valid_to,
      episodeId: r.episode_id, createdAt: r.created_at,
    }));
  }

  entitiesByIds(userId: string, ids: number[]): EntityNode[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM eg_entities WHERE user_id = ? AND id IN (${placeholders})`)
      .all(userId, ...ids);
    return rows.map(r => ({
      id: r.id, userId, name: r.name, type: r.type,
      summary: r.summary, createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  /** All currently-valid facts for a user (compact briefing for recall). */
  brief(userId: string, limit = 30): { entities: EntityNode[]; edges: EntityEdge[] } {
    const rows = this.db
      .prepare(
        `SELECT id, source_id, target_id FROM eg_edges
         WHERE user_id = ? AND valid_to IS NULL ORDER BY created_at DESC LIMIT ?`,
      )
      .all(userId, limit);
    if (rows.length === 0) return { entities: [], edges: [] };
    const ids = new Set<number>();
    for (const r of rows) { ids.add(r.source_id); ids.add(r.target_id); }
    const idArr = [...ids];
    return {
      entities: this.entitiesByIds(userId, idArr),
      edges: this.validEdgesFor(userId, idArr, limit),
    };
  }

  /** Format graph context for recall injection (compact, cached-friendly). */
  formatBrief(userId: string, limit = 30): string | null {
    const { entities, edges } = this.brief(userId, limit);
    if (edges.length === 0) return null;
    const nameOf = new Map(entities.map(e => [e.id, e.name]));
    const lines = edges.map(e =>
      `- ${nameOf.get(e.sourceId) ?? "?"} → ${nameOf.get(e.targetId) ?? "?"}: ${e.fact}`,
    );
    return `<entity-graph>\n${lines.join("\n")}\n</entity-graph>`;
  }
}

// -- Self-check -------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = "/tmp/eg-selftest-" + Date.now();
  const store = new EntityGraphStore(path.join(dir, "test.db"));
  const a = store.resolve("u1", "Искандер", "person");
  const b = store.resolve("u1", "coldwave", "concept");
  // duplicate resolve → same id
  const a2 = store.resolve("u1", "искандер ", "person");
  console.assert(a === a2, "resolve must be idempotent");
  store.addFact("u1", a, b, "любит coldwave");
  store.addFact("u1", a, b, "не любит coldwave"); // contradiction → invalidates
  const brief = store.brief("u1");
  console.assert(brief.edges.length === 1, "only current fact valid");
  console.assert(brief.edges[0].fact === "не любит coldwave", "newest wins");
  const other = store.brief("u2");
  console.assert(other.edges.length === 0, "per-user isolation");
  const fmt = store.formatBrief("u1");
  console.assert(fmt !== null && fmt.includes("искандер"), "formatBrief works");
  console.assert(!store.formatBrief("u2"), "no brief for unknown user");
  console.log("ENTITY GRAPH SELFTEST PASSED");
}
