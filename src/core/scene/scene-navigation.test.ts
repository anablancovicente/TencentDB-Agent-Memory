/**
 * Runnable check for the scene-navigation size caps (hermes-profile-mechanics §13).
 *
 * scene-navigation is injected EVERY turn into an IMMORTAL role=user
 * <memory-context> block that no compressor pass can shrink, duplicated across
 * the whole protected-tail floor. Unbounded full Chinese summaries here blew the
 * tail to 157846 tokens. These tests pin the two bounds — the per-summary clamp
 * and the total-char cap that drops the coolest scenes — so the runaway cannot
 * silently regress.
 */

import { describe, expect, it, vi } from "vitest";
import { generateSceneNavigation } from "./scene-navigation.js";
import type { SceneIndexEntry } from "./scene-index.js";

// Mirror of the default caps in scene-navigation.ts (SCENE_SUMMARY_CHAR_CAP).
// Kept as a literal so a silent default change fails the test loudly instead of
// drifting unnoticed.
const DEFAULT_SUMMARY_CAP = 120;
// "Summary: " prefix (9) + clamped body (120) + the "…" ellipsis (1).
const SUMMARY_LINE_MAX = "Summary: ".length + DEFAULT_SUMMARY_CAP + 1;

function entry(filename: string, heat: number, summaryLen: number): SceneIndexEntry {
  return {
    filename,
    summary: "场".repeat(summaryLen),
    heat,
    created: "2026-08-01",
    updated: "2026-08-21",
  };
}

// 15 scenes = the measured worst case (up to 15 in the index). Heats descend so
// scene_0 is hottest and scene_14 coolest, matching the heat-desc sort inside.
function manyScenes(summaryLen: number): SceneIndexEntry[] {
  return Array.from({ length: 15 }, (_, i) => entry(`scene_${i}.md`, 1500 - i * 100, summaryLen));
}

function summaryLines(nav: string): string[] {
  return nav.split("\n").filter((l) => l.startsWith("Summary: "));
}

describe("generateSceneNavigation size caps", () => {
  it("bounds the whole nav far below the old runaway blow-up", () => {
    // The unbounded version averaged ~17744 chars and peaked at ~25859. With
    // 1500-char summaries per scene the cap must hold the nav under ~2.8KB.
    const nav = generateSceneNavigation(manyScenes(1500));
    expect(nav.length).toBeLessThan(2800);
  });

  it("clamps every Summary line to the per-summary cap", () => {
    const nav = generateSceneNavigation(manyScenes(1500));
    const lines = summaryLines(nav);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(SUMMARY_LINE_MAX);
    }
  });

  it("keeps the hottest scene, drops the coolest, and notes the omission", () => {
    const nav = generateSceneNavigation(manyScenes(400));
    expect(nav).toContain("scene_0.md"); // hottest (heat 1500) survives
    expect(nav).not.toContain("scene_14.md"); // coolest (heat 100) dropped
    expect(nav).toMatch(/另有 \d+ 个低热度场景未列出/);
  });

  it("always emits at least the hottest scene, even a single huge one", () => {
    const nav = generateSceneNavigation([entry("scene_0.md", 999, 5000)]);
    expect(nav).toContain("scene_0.md");
    expect(nav).toContain("Summary: ");
    // The 5000-char summary is still clamped to the per-summary cap.
    for (const line of summaryLines(nav)) {
      expect(line.length).toBeLessThanOrEqual(SUMMARY_LINE_MAX);
    }
  });

  it("returns empty string for an empty index", () => {
    expect(generateSceneNavigation([])).toBe("");
  });

  it("keeps all scenes and omits the note when they fit under the cap", () => {
    const nav = generateSceneNavigation([
      entry("scene_a.md", 50, 40),
      entry("scene_b.md", 30, 40),
    ]);
    expect(nav).toContain("scene_a.md");
    expect(nav).toContain("scene_b.md");
    expect(nav).not.toMatch(/另有/); // nothing dropped
    expect(nav).toContain("场".repeat(40)); // short summary survives untruncated
  });

  it("honors TDAI_SCENE_NAV_TOTAL_CHARS override (env-tunable knob)", async () => {
    // The caps are read at module load, so reset the registry and re-import
    // after stubbing the env to observe the override take effect.
    vi.resetModules();
    vi.stubEnv("TDAI_SCENE_NAV_TOTAL_CHARS", "300");
    const mod = await import("./scene-navigation.js");
    const nav = mod.generateSceneNavigation(manyScenes(200));
    expect(nav).toContain("scene_0.md"); // hottest always kept
    expect(nav).toMatch(/另有 \d+ 个低热度场景未列出/); // tighter cap drops more
    vi.unstubAllEnvs();
  });
});
