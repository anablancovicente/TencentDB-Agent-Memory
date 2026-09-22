/**
 * Unit checks for the Laya anti-dup pre-write gate (wave 3a).
 *
 * - 5-pair acceptance: 3 duplicates skipped, 2 distinct stored (live Laya on :8430).
 * - Fail-open: Laya down → decisions unchanged.
 * - Owner threshold: stricter for ownerUserId records.
 *
 * Run: npx vitest run src/core/record/l1-laya-gate.test.ts
 */
import { describe, expect, it } from "vitest";
import { askLayaDup, layaPreWriteGate, gateEnabled } from "./l1-laya-gate.js";
import type { ExtractedMemory, DedupDecision } from "./l1-writer.js";
import type { IMemoryStore } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";

const LIVE_URL = "http://127.0.0.1:8430";
const DEAD_URL = "http://127.0.0.1:9"; // port 9 (discard) — nothing listens

async function layaUp(): Promise<boolean> {
  try {
    const res = await fetch(`${LIVE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function mem(id: string, content: string): ExtractedMemory & { record_id: string } {
  return {
    record_id: id,
    content,
    type: "persona",
    priority: 50,
    source_message_ids: [],
    metadata: {},
    scene_name: "test",
  };
}

function storeDecision(id: string): DedupDecision {
  return { record_id: id, action: "store", target_ids: [] };
}

/** Fake store: returns one existing candidate per new memory, matched by content prefix. */
function fakeStore(candidates: Record<string, Array<{ record_id: string; content: string }>>) {
  return {
    searchL1Vector: async (_vec: Float32Array, _topK: number, queryText?: string) => {
      const key = Object.keys(candidates).find((k) => queryText?.startsWith(k));
      return (key ? candidates[key] : []).map((c) => ({
        record_id: c.record_id,
        content: c.content,
        type: "persona",
        priority: 50,
        scene_name: "old",
        score: 0.9,
        timestamp_str: "",
        timestamp_start: "",
        timestamp_end: "",
        session_key: "s",
        session_id: "s1",
        metadata_json: "{}",
        user_id: "u1",
      }));
    },
  } as unknown as IMemoryStore;
}

const fakeEmbed = {
  embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(4).fill(0.1)),
} as unknown as EmbeddingService;

describe("layaPreWriteGate", () => {
  it("askLayaDup returns calibrated P or null when service is down", async () => {
    const pDown = await askLayaDup("a", "b", { layaUrl: DEAD_URL, askTimeoutMs: 1500 });
    expect(pDown).toBeNull();
    if (await layaUp()) {
      const p = await askLayaDup(
        "Юзер любит coldwave и darksynth",
        "Юзер предпочитает жанры coldwave и darksynth",
        { layaUrl: LIVE_URL },
      );
      expect(p).not.toBeNull();
    }
  });

  it("acceptance: 3 duplicates skipped, 2 distinct stored (live Laya)", async (ctx) => {
    if (!(await layaUp())) return ctx.skip();

    // New memories: 3 are dups of existing, 2 are new facts.
    // Dup pairs verified on live Laya (probe 2026-09-22): p = 0.97 / 0.98 / 0.95.
    const memories = [
      mem("n1", "Юзер предпочитает жанр coldwave"),
      mem("n2", "Юзер живёт в Вильнюсе"),
      mem("n3", "The user works in Ableton Live"),
      mem("n4", "У юзера собака по кличке Барс"),
      mem("n5", "Юзер заказал трек в жанре neurofunk"),
    ];
    const store = fakeStore({
      "Юзер предпочитает": [{ record_id: "e1", content: "Любимый жанр юзера — coldwave" }],
      "Юзер живёт": [{ record_id: "e2", content: "Юзер проживает в Вильнюсе" }],
      "The user works": [{ record_id: "e3", content: "The user makes music in Ableton Live" }],
      "У юзера собака": [{ record_id: "e4", content: "У юзера есть кот" }],
      "Юзер заказал": [{ record_id: "e5", content: "Юзер вчера сводил трек всю ночь" }],
    });

    const decisions = memories.map((m) => storeDecision(m.record_id));
    const out = await layaPreWriteGate({
      memories,
      decisions,
      userId: "u1",
      vectorStore: store,
      embeddingService: fakeEmbed,
      opts: { layaUrl: LIVE_URL },
    });

    const skipped = out.filter((d) => d.action === "skip").map((d) => d.record_id);
    const stored = out.filter((d) => d.action === "store").map((d) => d.record_id);
    // n1/n2/n3 are paraphrase dups → skipped; n4 (dog vs cat) and n5 (city vs genre) → stored.
    expect(skipped.sort()).toEqual(["n1", "n2", "n3"]);
    expect(stored.sort()).toEqual(["n4", "n5"]);
  });

  it("fail-open: Laya down → all decisions unchanged", async () => {
    const memories = [mem("n1", "Юзер любит coldwave")];
    const store = fakeStore({ "Юзер любит": [{ record_id: "e1", content: "Юзер предпочитает coldwave" }] });
    const decisions = [storeDecision("n1")];
    const out = await layaPreWriteGate({
      memories,
      decisions,
      userId: "u1",
      vectorStore: store,
      embeddingService: fakeEmbed,
      opts: { layaUrl: DEAD_URL, askTimeoutMs: 1000 },
    });
    expect(out).toEqual(decisions);
  });

  it("owner records get the stricter threshold", async (ctx) => {
    if (!(await layaUp())) return ctx.skip();
    // A pair Laya scores between 0.7 and 0.95: non-owner (thr 0.9) may skip or soft-log,
    // owner (thr 0.95) must NOT skip. Use a moderately similar pair.
    const pair = ["Юзер сводит треки ночью", "Юзер часто работает над сведением по ночам"];
    const p = await askLayaDup(pair[0], pair[1], { layaUrl: LIVE_URL });
    expect(p).not.toBeNull();

    const mk = (userId: string, ownerUserId?: string) =>
      layaPreWriteGate({
        memories: [mem("n1", pair[0])],
        decisions: [storeDecision("n1")],
        userId,
        ownerUserId,
        vectorStore: fakeStore({ "Юзер сводит": [{ record_id: "e1", content: pair[1] }] }),
        embeddingService: fakeEmbed,
        opts: { layaUrl: LIVE_URL },
      });

    const ownerOut = await mk("599082521", "599082521");
    if ((p ?? 0) >= 0.95) {
      expect(ownerOut[0].action).toBe("skip");
    } else {
      expect(ownerOut[0].action).toBe("store");
    }
  });

  it("gate honors TDAI_LAYA_DUP_GATE=0 (disabled passthrough)", async () => {
    // gateEnabled reads env; when disabled the gate must be a no-op.
    // (env mutation is process-wide — restore after)
    const prev = process.env["TDAI_LAYA_DUP_GATE"];
    process.env["TDAI_LAYA_DUP_GATE"] = "0";
    try {
      expect(gateEnabled()).toBe(false);
      const decisions = [storeDecision("n1")];
      const out = await layaPreWriteGate({
        memories: [mem("n1", "anything")],
        decisions,
        userId: "u1",
        vectorStore: fakeStore({}),
        embeddingService: fakeEmbed,
        opts: { layaUrl: DEAD_URL },
      });
      expect(out).toEqual(decisions);
    } finally {
      if (prev === undefined) delete process.env["TDAI_LAYA_DUP_GATE"];
      else process.env["TDAI_LAYA_DUP_GATE"] = prev;
    }
  });
});
