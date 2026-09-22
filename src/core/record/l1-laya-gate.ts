/**
 * Laya-based anti-duplication pre-write gate for L1 memories (wave 3a).
 *
 * Runs AFTER batchDedup decisions and BEFORE writes: for each memory about to
 * be stored as new, recalls top-N nearest existing records of the same user
 * (vector search + user-scope visibility) and asks the local Laya System-1
 * service (noul, calibrated P(true)) whether each pair is a duplicate.
 *
 * Decision bands (per pair probability p, max across candidates wins):
 *   p >= threshold (owner: ownerThreshold) → decision becomes "skip" (logged)
 *   softThreshold <= p < threshold         → stored, logged as possible_dup
 *   otherwise                              → stored silently
 *
 * Fail-open: gate disabled, no vector store, Laya unreachable/slow/malformed
 * → original decisions are returned unchanged. Runs on the async capture
 * pipeline, never blocks a live response.
 *
 * Env:
 *   TDAI_LAYA_DUP_GATE=0        → disable gate (default: enabled)
 *   TDAI_LAYA_URL               → service base URL (default http://127.0.0.1:8430)
 *   TDAI_LAYA_DUP_THRESHOLD     → override skip threshold (default 0.9)
 *   TDAI_LAYA_DUP_OWNER_THRESHOLD → override owner threshold (default 0.95)
 */

import type { ExtractedMemory, DedupDecision } from "./l1-writer.js";
import type { IMemoryStore } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { Logger } from "../types.js";
import { memoryVisibleTo } from "../tools/user-scope.js";
import { getEnv } from "../../utils/env.js";

const TAG = "[memory-tdai][laya-dup-gate]";

const DEFAULT_LAYA_URL = "http://127.0.0.1:8430";
const DEFAULT_THRESHOLD = 0.9;
const DEFAULT_OWNER_THRESHOLD = 0.95;
const DEFAULT_SOFT_THRESHOLD = 0.7;
const DEFAULT_ASK_TIMEOUT_MS = 2500;
const DEFAULT_TOP_CANDIDATES = 3;

export interface LayaGateOptions {
  layaUrl?: string;
  threshold?: number;
  ownerThreshold?: number;
  softThreshold?: number;
  askTimeoutMs?: number;
  topCandidates?: number;
}

function envFloat(key: string, fallback: number): number {
  const raw = getEnv(key);
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

export function gateEnabled(): boolean {
  const v = getEnv("TDAI_LAYA_DUP_GATE");
  return v !== "0" && v !== "false";
}

/**
 * Ask Laya whether two memory records state the same fact.
 * Returns calibrated P(duplicate) or null on any failure (fail-open).
 *
 * Prompt form is calibrated empirically (2026-09-22): statement-style single
 * question, both records in `state`. Multi-question batches cross-contaminate
 * (all answers drift to ~0.99) — one HTTP request per pair.
 */
export async function askLayaDup(
  newContent: string,
  existingContent: string,
  opts: LayaGateOptions = {},
): Promise<number | null> {
  const url = opts.layaUrl ?? getEnv("TDAI_LAYA_URL") ?? DEFAULT_LAYA_URL;
  const timeoutMs = opts.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  const payload = {
    state: `Запись 1: ${newContent}\nЗапись 2: ${existingContent}`,
    questions: {
      same_fact: {
        type: "noul",
        instructions:
          "Утверждение: запись 1 и запись 2 — это дубликаты, один и тот же факт о пользователе. Верно ли утверждение?",
      },
    },
  };
  try {
    const res = await fetch(`${url}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const out = (await res.json()) as {
      answers?: { same_fact?: { noul?: number } };
    };
    const p = out?.answers?.same_fact?.noul;
    return typeof p === "number" && Number.isFinite(p) ? p : null;
  } catch {
    return null; // unreachable / timeout / malformed → fail-open
  }
}

/**
 * Pre-write gate: filter "store" decisions through Laya duplicate scoring.
 * Mutates nothing; returns a new decisions array.
 */
export async function layaPreWriteGate(params: {
  memories: Array<ExtractedMemory & { record_id: string }>;
  decisions: DedupDecision[];
  userId?: string;
  ownerUserId?: string;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  logger?: Logger;
  opts?: LayaGateOptions;
}): Promise<DedupDecision[]> {
  const { memories, decisions, userId, ownerUserId, vectorStore, embeddingService, logger } = params;
  const opts = params.opts ?? {};

  if (!gateEnabled() || !vectorStore || !embeddingService) {
    return decisions;
  }

  const threshold = opts.threshold ?? envFloat("TDAI_LAYA_DUP_THRESHOLD", DEFAULT_THRESHOLD);
  const ownerThreshold = opts.ownerThreshold ?? envFloat("TDAI_LAYA_DUP_OWNER_THRESHOLD", DEFAULT_OWNER_THRESHOLD);
  const softThreshold = opts.softThreshold ?? DEFAULT_SOFT_THRESHOLD;
  const topCandidates = opts.topCandidates ?? DEFAULT_TOP_CANDIDATES;
  const isOwner = !!userId && userId === ownerUserId;
  const skipThreshold = isOwner ? Math.max(threshold, ownerThreshold) : threshold;

  const storeIds = new Set(decisions.filter((d) => d.action === "store").map((d) => d.record_id));
  const gated = [...decisions];

  try {
    const batchIds = new Set(memories.map((m) => m.record_id));
    const toCheck = memories.filter((m) => storeIds.has(m.record_id));
    if (toCheck.length === 0) return decisions;

    const embeddings = await embeddingService.embedBatch(toCheck.map((m) => m.content));

    for (let i = 0; i < toCheck.length; i++) {
      const mem = toCheck[i];
      let results;
      try {
        results = await vectorStore.searchL1Vector(embeddings[i], topCandidates + batchIds.size, mem.content);
      } catch {
        continue; // recall failed for this memory → fail-open (store)
      }
      const candidates = results
        .filter((r) => !batchIds.has(r.record_id) && memoryVisibleTo(r.user_id, userId, ownerUserId))
        .slice(0, topCandidates);
      if (candidates.length === 0) continue;

      let maxP = -1;
      let maxContent = "";
      for (const cand of candidates) {
        const p = await askLayaDup(mem.content, cand.content, opts);
        if (p === null) continue; // laya down/slow → this pair abstains
        if (p > maxP) {
          maxP = p;
          maxContent = cand.content;
        }
      }
      if (maxP < 0) continue; // all pairs abstained → fail-open

      if (maxP >= skipThreshold) {
        const idx = gated.findIndex((d) => d.record_id === mem.record_id);
        if (idx >= 0) {
          gated[idx] = { record_id: mem.record_id, action: "skip", target_ids: [] };
          logger?.info(
            `${TAG} SKIPPED duplicate (p=${maxP.toFixed(3)} >= ${skipThreshold}, owner=${isOwner}): ` +
              `new="${mem.content.slice(0, 80)}" ~ existing="${maxContent.slice(0, 80)}"`,
          );
        }
      } else if (maxP >= softThreshold) {
        logger?.info(
          `${TAG} possible_dup (p=${maxP.toFixed(3)}, stored): ` +
            `new="${mem.content.slice(0, 80)}" ~ existing="${maxContent.slice(0, 80)}"`,
        );
      }
    }
  } catch (err) {
    // Any unexpected failure → fail-open with original decisions
    logger?.warn?.(
      `${TAG} gate failed, fail-open (storing all): ${err instanceof Error ? err.message : String(err)}`,
    );
    return decisions;
  }

  return gated;
}
