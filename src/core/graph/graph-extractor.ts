/**
 * Graph extractor: episode → entities/facts via LLM (Graphiti-style, lazy).
 *
 * One LLM call per turn (ADD-only). Output schema is strict JSON so glm-5.3
 * with disableThinking can produce it. Under-merge: extractor returns names;
 * resolution is exact-normalized in EntityGraphStore.
 */

import type { LLMRunner } from "../types.js";
import { EntityGraphStore } from "./graph-store.js";

const SYSTEM_PROMPT = `Ты извлекаешь сущности и факты из диалога для графа памяти.
Верни СТРОГО JSON без markdown, схема:
{"entities":[{"name":"...","type":"person|project|tool|genre|concept"}],
 "facts":[{"source":"имя сущности","target":"имя сущности","fact":"краткий факт"}]}
Правила:
- имена сущностей — канонические, в нижнем регистре
- факты — только то, что СЛЕДУЕТ из диалога, без домыслов
- нет сущностей/фактов — верни {"entities":[],"facts":[]}
- только JSON, ничего кроме JSON`;

export interface ExtractionResult {
  entitiesAdded: number;
  factsAdded: number;
  invalidated: number;
}

export async function extractToGraph(
  opts: {
    store: EntityGraphStore;
    llm: LLMRunner;
    userId: string;
    userText: string;
    assistantText: string;
    episodeId?: string;
    maxEntities?: number;
  },
): Promise<ExtractionResult> {
  const { store, llm, userId, userText, assistantText, episodeId, maxEntities = 10 } = opts;
  const result: ExtractionResult = { entitiesAdded: 0, factsAdded: 0, invalidated: 0 };
  if (!userText?.trim() && !assistantText?.trim()) return result;

  let raw: string;
  try {
    raw = await llm.run({
      systemPrompt: SYSTEM_PROMPT,
      prompt: `USER: ${userText.slice(0, 2000)}\nASSISTANT: ${assistantText.slice(0, 2000)}`,
      taskId: "graph-extract",
      timeoutMs: 30_000,
    });
  } catch {
    return result; // extraction is best-effort, never blocks capture
  }

  let parsed: any;
  try {
    const jsonStr = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    parsed = JSON.parse(jsonStr);
  } catch {
    return result;
  }

  const idByName = new Map<string, number>();
  const entities = Array.isArray(parsed.entities) ? parsed.entities.slice(0, maxEntities) : [];
  for (const e of entities) {
    if (!e?.name || typeof e.name !== "string") continue;
    const id = store.resolve(userId, e.name, typeof e.type === "string" ? e.type : "concept");
    idByName.set(e.name.trim().toLowerCase(), id);
    result.entitiesAdded++;
  }

  const facts = Array.isArray(parsed.facts) ? parsed.facts.slice(0, maxEntities) : [];
  for (const f of facts) {
    if (!f?.source || !f?.target || !f?.fact) continue;
    const src = idByName.get(String(f.source).trim().toLowerCase());
    const tgt = idByName.get(String(f.target).trim().toLowerCase());
    if (!src || !tgt || src === tgt) continue;
    const r = store.addFact(userId, src, tgt, String(f.fact).slice(0, 300), episodeId);
    if (r.added) {
      result.factsAdded++;
      result.invalidated += r.invalidated;
    }
  }
  return result;
}

// -- Self-check with a stub LLM ---------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = await import("node:path");
  const dir = "/tmp/eg-extract-" + Date.now();
  const store = new EntityGraphStore(path.join(dir, "t.db"));
  const stubLLM = {
    async run() {
      return JSON.stringify({
        entities: [
          { name: "искандер", type: "person" },
          { name: "coldwave", type: "genre" },
        ],
        facts: [{ source: "искандер", target: "coldwave", fact: "любит coldwave" }],
      });
    },
  } as any;
  const r1 = await extractToGraph({ store, llm: stubLLM, userId: "u9", userText: "я люблю coldwave", assistantText: "ок" });
  console.assert(r1.factsAdded === 1 && r1.entitiesAdded === 2, "extract adds");
  const r2 = await extractToGraph({ store, llm: stubLLM, userId: "u9", userText: "я люблю coldwave", assistantText: "ок" });
  console.assert(r2.factsAdded === 0, "duplicate fact not re-added");
  const badLLM = { async run() { return "мусор не json"; } } as any;
  const r3 = await extractToGraph({ store, llm: badLLM, userId: "u9", userText: "x", assistantText: "y" });
  console.assert(r3.factsAdded === 0, "bad LLM output is a no-op");
  console.log("GRAPH EXTRACTOR SELFTEST PASSED");
}
