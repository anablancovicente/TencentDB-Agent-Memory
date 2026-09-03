/**
 * Scene navigation: generates a summary navigation section appended to persona.md.
 *
 * The navigation includes **absolute** file paths so the agent can directly
 * use read_file for on-demand scene loading (progressive disclosure).
 */

import path from "node:path";
import type { SceneIndexEntry } from "./scene-index.js";

const NAV_HEADER = "---\n## 🗺️ Scene Navigation (Scene Index)";

const NAV_FOOTER = `📌 使用说明：
- Path 是 scene block 的绝对路径，可直接使用 read_file 读取完整内容
- 热度：该场景被记忆命中的累计次数，越高越重要
- Summary：场景的核心要点摘要`;

/**
 * Build a fire-emoji string based on heat value (visual priority cue for the agent).
 */
function heatEmoji(heat: number): string {
  if (heat >= 1000) return " 🔥🔥🔥🔥🔥";
  if (heat >= 500) return " 🔥🔥🔥🔥";
  if (heat >= 200) return " 🔥🔥🔥";
  if (heat >= 100) return " 🔥🔥";
  if (heat >= 50) return " 🔥";
  return "";
}

// ---------------------------------------------------------------------------
// ponytail: scene-nav is a progressive-disclosure INDEX, not content — the full
// scene lives in scene_blocks/*.md and is read_file'd on demand. This string is
// injected EVERY turn into an IMMORTAL role=user <memory-context> block (Hermes)
// that no compressor pass can shrink, duplicated across the whole protected tail
// floor. Unbounded full Chinese summaries here blew the tail to 157846 tokens
// (hermes-profile-mechanics §13). Bound per-summary + total; entries are heat-sorted
// desc so the total cap drops the COOLEST scenes first. Env-tunable at gateway launch.
// ---------------------------------------------------------------------------
function envIntCap(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const SCENE_SUMMARY_CHAR_CAP = envIntCap("TDAI_SCENE_NAV_SUMMARY_CHARS", 120);
const SCENE_NAV_TOTAL_CHAR_CAP = envIntCap("TDAI_SCENE_NAV_TOTAL_CHARS", 2000);

function clampText(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap).trimEnd()}…` : s;
}

/**
 * Generate the scene navigation Markdown section.
 *
 * The output is bounded (see SCENE_*_CHAR_CAP above): each Summary is truncated
 * and the scene list is cut at SCENE_NAV_TOTAL_CHAR_CAP, dropping the coolest
 * scenes (entries are heat-sorted desc). At least the hottest scene is always
 * emitted; when scenes are dropped a short "N more" note is appended.
 *
 * @param entries - Scene index entries
 * @param dataDir - Absolute path to the plugin data directory; when provided,
 *                  scene paths are rendered as absolute paths so the agent can
 *                  call read_file directly without path concatenation.
 */
export function generateSceneNavigation(entries: SceneIndexEntry[], dataDir?: string): string {
  if (entries.length === 0) return "";

  const sorted = [...entries].sort((a, b) => b.heat - a.heat);

  const blocks: string[] = [];
  let total = 0;
  let omitted = 0;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const scenePath = dataDir
      ? path.join(dataDir, "scene_blocks", e.filename)
      : `scene_blocks/${e.filename}`;
    const pathLine = `### Path: ${scenePath}`;
    const heatLine = `**热度**: ${e.heat}${heatEmoji(e.heat)}${e.updated ? ` | **更新**: ${e.updated}` : ""}`;
    const summaryLine = `Summary: ${clampText(e.summary, SCENE_SUMMARY_CHAR_CAP)}`;
    const block = `${pathLine}\n${heatLine}\n${summaryLine}`;
    const sep = blocks.length === 0 ? 0 : 2; // "\n\n" joiner
    // Total-char backstop: never let the scene list exceed the cap. sorted is
    // heat-desc, so this scene and everything after it are the coolest ones.
    if (blocks.length > 0 && total + sep + block.length > SCENE_NAV_TOTAL_CHAR_CAP) {
      omitted = sorted.length - i;
      break;
    }
    blocks.push(block);
    total += sep + block.length;
  }

  const omittedNote =
    omitted > 0
      ? `\n\n*…另有 ${omitted} 个低热度场景未列出（可 read_file scene_blocks/ 查看）。*`
      : "";

  return `${NAV_HEADER}\n*以下是当前场景记忆的索引，可根据需要 read_file 读取详细内容。*\n\n${blocks.join("\n\n")}${omittedNote}\n\n${NAV_FOOTER}`;
}

/**
 * Strip the scene navigation section from persona content.
 */
export function stripSceneNavigation(personaContent: string): string {
  const idx = personaContent.indexOf(NAV_HEADER);
  if (idx === -1) return personaContent;
  return personaContent.slice(0, idx).trimEnd();
}
