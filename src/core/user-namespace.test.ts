/**
 * Per-user namespace invariants — attribution (write path) and visibility (read path).
 *
 * Why this file exists: the identity work landed as `e806148 per-user isolation`
 * (capture writes user_id, search filters by user_id, ownerUserId sees the legacy
 * `default` pool). Two governance findings followed (2026-08-29 / 2026-08-30):
 * the owner's private scenes were still reachable by other actors, and stale
 * `profiles/<id>/` directories kept unlocking them. Auditing the code showed the
 * isolation was never actually plumbed end to end:
 *
 *   D0  `l0_conversations` / `l1_records` DDL have no `user_id` column, while the
 *       prepared statements bind and select it. On a fresh data dir `init()` fails
 *       schema creation and the store goes degraded — every read/write becomes a
 *       silent no-op. Live data only survives because its DB was created by a
 *       divergent build that happened to carry the column.
 *   D1  L1 attribution is *guessed*: `resolveUserIdForSession` picks the newest
 *       non-`default` L0 row of the whole session_key. Two authors sharing a
 *       session (group chat — sessionKey/sessionId/userId are all caller-supplied)
 *       means the last speaker owns everybody's memories.
 *   D2  When the scoped L0 rows are gone (retention prune) or absent (L1 written
 *       directly), the guess collapses to `default` — i.e. a stranger's memory
 *       lands in the pool the owner can see. This is the re-pollution source.
 *   D4  Scene navigation is gated on the *existence* of any
 *       `profiles/<actorId>/persona.md`, not on identity. Nothing in the repo
 *       writes those files (L3 writes the global `<dataDir>/persona.md`), so a
 *       leftover directory from an old build grants a non-owner the owner's full
 *       global scene index. Symmetrically, the configured owner gets nothing when
 *       no such directory exists.
 *
 * Every test runs on an isolated temp data dir + temp SQLite file with a
 * deterministic marker-echo LLM stub: no network, no embeddings, no live data.
 *
 * Run: `npx vitest run src/core/user-namespace.test.ts`
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseConfig } from "../config.js";
import { createL1Runner } from "../utils/pipeline-factory.js";
import { performAutoRecall } from "./hooks/auto-recall.js";
import { VectorStore } from "./store/sqlite.js";
import { memoryVisibleTo } from "./tools/user-scope.js";
import type { L0Record, MemoryRecord } from "./store/types.js";
import type { LLMRunner, Logger } from "./types.js";

/** Fixed epoch so timestamps are stable across runs (2023-11-14T22:13:20Z). */
const EPOCH = 1_700_000_000_000;

/** Identity of the configured owner vs. an unrelated actor on the same platform. */
const OWNER = "telegram:111";
const STRANGER = "telegram:222";

// ============================
// Temp-dir bookkeeping
// ============================

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ============================
// Helpers
// ============================

function makeLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const record = (level: string) => (msg: string) => {
    lines.push(`${level}: ${msg}`);
  };
  return { logger: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") }, lines };
}

/**
 * Read a table with a *second* connection after the store is closed.
 *
 * Deliberately independent of the store's own query paths: if the schema is
 * broken (D0) or a projection drops a column, this still shows the truth.
 */
function readTable(dbPath: string, table: string, columns: string[]): Array<Record<string, unknown>> {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(`SELECT ${columns.join(", ")} FROM ${table}`).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function l0Record(seq: number, marker: string, userId: string, sessionKey: string, sessionId: string): L0Record {
  const ts = EPOCH + seq * 1000;
  return {
    id: `l0-${seq}`,
    sessionKey,
    sessionId,
    role: "user",
    // Natural-language sentence (not symbol-only) so it passes shouldExtractL1().
    messageText: `${marker} 我每天早上都在河边的公园跑步，这件事请长期记住`,
    recordedAt: new Date(ts).toISOString(),
    timestamp: ts,
    userId,
  };
}

function memoryRecord(p: { id: string; content: string; sessionKey: string; sessionId?: string; userId?: string }): MemoryRecord {
  const iso = new Date(EPOCH).toISOString();
  return {
    id: p.id,
    content: p.content,
    type: "instruction",
    priority: 50,
    scene_name: "test-scene",
    source_message_ids: [],
    metadata: {},
    timestamps: [iso],
    createdAt: iso,
    updatedAt: iso,
    sessionKey: p.sessionKey,
    sessionId: p.sessionId ?? "",
    userId: p.userId,
  };
}

/**
 * Deterministic LLM stub for L1 extraction.
 *
 * `formatExtractionPrompt` renders each message as `[id] [role] [ts]: content`,
 * so the markers written into L0 are visible in the prompt: echoing one scene per
 * marker found makes the stub attribute each extracted memory to the author group
 * whose messages were actually in the batch.
 *
 * Scene names deliberately avoid the markers. The runner threads the previous
 * group's `scene_name` into the next group's prompt (`【上一个情境】`), so a
 * marker-bearing scene name would make the stub re-emit the previous author's
 * memory — stamped with the next author's identity.
 */
const STUB_MARKERS = ["MARKER-A", "MARKER-B"] as const;
const STUB_SCENES: Record<(typeof STUB_MARKERS)[number], string> = { "MARKER-A": "情境甲", "MARKER-B": "情境乙" };

const stubRunner: LLMRunner = {
  async run({ prompt }) {
    const scenes = STUB_MARKERS.filter((m) => prompt.includes(m)).map((m) => ({
      scene_name: STUB_SCENES[m],
      message_ids: [],
      memories: [{ content: `记忆 ${m}`, type: "episodic", priority: 60, source_message_ids: [], metadata: {} }],
    }));
    return JSON.stringify(scenes);
  },
};

// ============================
// D0 — schema must actually carry the identity it binds
// ============================

describe("D0: user_id survives a fresh store round-trip", () => {
  it("writes and reads back the supplied identity on L0 and L1", async () => {
    const dir = await tempDir("tm-d0-");
    const dbPath = path.join(dir, "vectors.db");
    const { logger, lines } = makeLogger();
    // dimensions=0 → no vec0 tables, metadata-only store (the degraded-free minimum).
    const store = new VectorStore(dbPath, 0, logger);
    const init = store.init();

    expect(store.isDegraded(), `store degraded: ${init.reason}\n${lines.join("\n")}`).toBe(false);
    expect(await store.upsertL0(l0Record(1, "MARKER-A", OWNER, OWNER, "conv-1"), undefined)).toBe(true);
    expect(store.countL0()).toBe(1);
    expect(
      await store.upsertL1(memoryRecord({ id: "l1-1", content: "MARKER-A 记忆", sessionKey: OWNER, sessionId: "conv-1", userId: OWNER }), undefined),
    ).toBe(true);
    expect(store.countL1()).toBe(1);

    store.close();
    expect(readTable(dbPath, "l0_conversations", ["record_id", "user_id"])).toEqual([{ record_id: "l0-1", user_id: OWNER }]);
    expect(readTable(dbPath, "l1_records", ["record_id", "user_id"])).toEqual([{ record_id: "l1-1", user_id: OWNER }]);
  });
});

// ============================
// D1 — attribution must follow the author, not the session
// ============================

describe("D1: two authors in one session keep their own L1 memories", () => {
  /**
   * Strictest realistic case: group chat — one sessionKey AND one sessionId,
   * two authors interleaved. Pre-fix, `resolveUserIdForSession` returns the
   * newest non-`default` L0 row for the whole session_key, so every memory of
   * that session is stamped with the last speaker's identity.
   */
  async function runSharedSession(sessionIds: [string, string]) {
    const dir = await tempDir("tm-d1-");
    const dbPath = path.join(dir, "vectors.db");
    const { logger } = makeLogger();
    const store = new VectorStore(dbPath, 0, logger);
    expect(store.init().needsReindex).toBe(false);
    expect(store.isDegraded()).toBe(false);

    const sessionKey = "telegram:group-1";
    for (const seq of [1, 2]) await store.upsertL0(l0Record(seq, "MARKER-A", OWNER, sessionKey, sessionIds[0]), undefined);
    for (const seq of [3, 4]) await store.upsertL0(l0Record(seq, "MARKER-B", STRANGER, sessionKey, sessionIds[1]), undefined);

    // enableDedup:false keeps the stub in charge — no embedding-based conflict recall.
    const cfg = parseConfig({ extraction: { enableDedup: false } });
    const runL1 = createL1Runner({
      pluginDataDir: dir,
      cfg,
      openclawConfig: undefined,
      vectorStore: store,
      embeddingService: undefined,
      logger,
      llmRunner: stubRunner,
    });
    const result = await runL1({ sessionKey });
    expect(result.processedCount).toBe(4);

    store.close();
    const ownerOf = new Map(
      readTable(dbPath, "l1_records", ["content", "user_id"]).map((r) => [String(r.content), String(r.user_id)]),
    );
    return { ownerOf, dir };
  }

  it("attributes each memory to its own author when both share sessionKey + sessionId", async () => {
    const { ownerOf } = await runSharedSession(["conv-1", "conv-1"]);
    expect(ownerOf.get("记忆 MARKER-A")).toBe(OWNER);
    expect(ownerOf.get("记忆 MARKER-B")).toBe(STRANGER);
  });

  it("attributes each memory to its own author when the sessionIds differ", async () => {
    const { ownerOf } = await runSharedSession(["conv-a", "conv-b"]);
    expect(ownerOf.get("记忆 MARKER-A")).toBe(OWNER);
    expect(ownerOf.get("记忆 MARKER-B")).toBe(STRANGER);
  });
});

// ============================
// D2 — a stranger's memory must never fall into the owner-visible pool
// ============================

describe("D2: identity is taken from the record, not re-derived from L0", () => {
  it("keeps the supplied userId when the session has no L0 rows", async () => {
    const dir = await tempDir("tm-d2-");
    const dbPath = path.join(dir, "vectors.db");
    const { logger } = makeLogger();
    const store = new VectorStore(dbPath, 0, logger);
    store.init();
    expect(store.isDegraded()).toBe(false);

    // No L0 at all: retention pruned it, or this L1 was written by a direct path.
    expect(
      await store.upsertL1(memoryRecord({ id: "l1-x", content: "MARKER-X 陌生人的记忆", sessionKey: "telegram:999", sessionId: "conv-x", userId: "telegram:999" }), undefined),
    ).toBe(true);

    store.close();
    // `"default"` here would put a stranger inside the owner-visible legacy pool.
    expect(readTable(dbPath, "l1_records", ["record_id", "user_id"])).toEqual([{ record_id: "l1-x", user_id: "telegram:999" }]);
  });
});

// ============================
// D4 — scene navigation is a right of the owner, not of a leftover directory
// ============================

/**
 * Fixture: a global scene index with one owner-private scene, plus its block file.
 * `userText: ""` is used by all recall calls below, so no store/embedding is needed.
 */
async function recallFixture(): Promise<{ dir: string; cfg: ReturnType<typeof parseConfig> }> {
  const dir = await tempDir("tm-d4-");
  await fs.mkdir(path.join(dir, "scene_blocks"), { recursive: true });
  await fs.mkdir(path.join(dir, ".metadata"), { recursive: true });
  await fs.writeFile(path.join(dir, "scene_blocks", "owner-private.md"), "# 私人场景\nOWNER-PRIVATE-BODY-MARKER\n", "utf-8");
  await fs.writeFile(
    path.join(dir, ".metadata", "scene_index.json"),
    JSON.stringify([
      { filename: "owner-private.md", summary: "OWNER-PRIVATE-SUMMARY-MARKER", heat: 900, created: "2026-08-01", updated: "2026-08-20" },
    ]),
    "utf-8",
  );
  return { dir, cfg: parseConfig({ recall: { ownerUserId: OWNER } }) };
}

async function recall(dir: string, cfg: ReturnType<typeof parseConfig>, actorId: string): Promise<string> {
  const result = await performAutoRecall({
    userText: "",
    actorId,
    sessionKey: actorId,
    cfg,
    pluginDataDir: dir,
    logger: makeLogger().logger,
  });
  return result?.appendSystemContext ?? "";
}

describe("D4: global scene navigation follows identity", () => {
  it("withholds the owner's scenes from a stranger who has a leftover profile dir", async () => {
    const { dir, cfg } = await recallFixture();
    // Nothing in this repo writes profiles/<id>/persona.md — this mirrors the
    // stale 44 KB directory found in the live data dir on 2026-08-30.
    await fs.mkdir(path.join(dir, "profiles", STRANGER), { recursive: true });
    await fs.writeFile(path.join(dir, "profiles", STRANGER, "persona.md"), "# 陌生人\nSTRANGER-OWN-PERSONA\n", "utf-8");

    const injected = await recall(dir, cfg, STRANGER);
    // Their own persona may stay; the owner's global scene index must not.
    expect(injected).toContain("STRANGER-OWN-PERSONA");
    expect(injected).not.toContain("OWNER-PRIVATE-SUMMARY-MARKER");
  });

  it("serves the owner's scenes even without any profile directory", async () => {
    const { dir, cfg } = await recallFixture();
    const injected = await recall(dir, cfg, OWNER);
    expect(injected).toContain("OWNER-PRIVATE-SUMMARY-MARKER");
  });

  it("stays silent for a stranger with no profile directory", async () => {
    const { dir, cfg } = await recallFixture();
    expect(await recall(dir, cfg, STRANGER)).not.toContain("OWNER-PRIVATE-SUMMARY-MARKER");
  });
});

// ============================
// Regression pins — already-correct behaviour must not be traded away
// ============================

describe("persona lookup boundary", () => {
  it("does not escape the profiles directory on a traversal actorId", async () => {
    const { dir, cfg } = await recallFixture();
    // path.join(dir, "profiles", "..", "persona.md") === the global L3 dossier.
    await fs.writeFile(path.join(dir, "persona.md"), "# 全局人设\nGLOBAL-DOSSIER-MARKER\n", "utf-8");
    const injected = await recall(dir, cfg, "..");
    expect(injected).not.toContain("GLOBAL-DOSSIER-MARKER");
    expect(injected).not.toContain("OWNER-PRIVATE-SUMMARY-MARKER");
  });

  it("does not cross platforms via the bare-numeric prefix strip", async () => {
    const { dir, cfg } = await recallFixture();
    // A bare numeric directory is not attributable to a platform: "111" could be
    // telegram:111, discord:111 or anything else, so it must not be served to a
    // same-numeric-id actor from a different platform.
    await fs.mkdir(path.join(dir, "profiles", "111"), { recursive: true });
    await fs.writeFile(path.join(dir, "profiles", "111", "persona.md"), "# Telegram 档案\nTELEGRAM-ONLY-DOSSIER-MARKER\n", "utf-8");
    expect(await recall(dir, cfg, "discord:111")).not.toContain("TELEGRAM-ONLY-DOSSIER-MARKER");
  });

  it("resolves nothing for an empty actorId", async () => {
    const { dir, cfg } = await recallFixture();
    await fs.mkdir(path.join(dir, "profiles"), { recursive: true });
    await fs.writeFile(path.join(dir, "persona.md"), "# 全局人设\nGLOBAL-DOSSIER-MARKER\n", "utf-8");
    // path.join(dir, "profiles", "", "persona.md") drops the empty segment and
    // lands on the profiles root — an empty identity is no identity at all.
    await fs.writeFile(path.join(dir, "profiles", "persona.md"), "# 根档案\nPROFILES-ROOT-MARKER\n", "utf-8");
    const injected = await recall(dir, cfg, "");
    expect(injected).not.toContain("PROFILES-ROOT-MARKER");
    expect(injected).not.toContain("GLOBAL-DOSSIER-MARKER");
    expect(injected).not.toContain("OWNER-PRIVATE-SUMMARY-MARKER");
  });
});

// ============================
// Legacy `default` pool — who may read the pre-fix rows
// ============================

describe("legacy pool visibility", () => {
  it("gives the pre-fix default rows to the configured owner only", () => {
    // Most of the live L1 rows are still user_id='default' (written before the
    // identity fix) — retroactively unattributable, so they stay owner-only.
    expect(memoryVisibleTo("default", OWNER, OWNER)).toBe(true);
    expect(memoryVisibleTo("default", STRANGER, OWNER)).toBe(false);
    expect(memoryVisibleTo(undefined, STRANGER, OWNER)).toBe(false);
    // Own rows, plus the cross-platform numeric collision at row level.
    expect(memoryVisibleTo(STRANGER, STRANGER, OWNER)).toBe(true);
    expect(memoryVisibleTo("telegram:111", "discord:111", OWNER)).toBe(false);
    // Unscoped calls are internal/seed paths and deliberately see everything.
    expect(memoryVisibleTo("default", undefined, OWNER)).toBe(true);
  });
});
