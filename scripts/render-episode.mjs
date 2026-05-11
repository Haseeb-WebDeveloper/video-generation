#!/usr/bin/env node
// Render one episode to out/<slug>.mp4 via the Remotion CLI.
//
// The composition id IS the slug — Root.tsx registers one Composition per
// episode JSON, keyed by slug. Duration auto-computed via calculateMetadata
// using totalFrames(items), so it matches the studio.
//
// Usage: node scripts/render-episode.mjs <slug>

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadEpisode, episodePaths } from "./lib/episode-loader.mjs";

const [, , compositionId] = process.argv;
if (!compositionId) {
  console.error(
    "Usage: node scripts/render-episode.mjs <slug>[-flow|-bars]",
  );
  process.exit(1);
}

// Composition ids are <slug>-flow or <slug>-bars (one per template). The
// episode JSON lives at episodes/<slug>.json — strip the template suffix to
// find it. A bare slug (no suffix) is rejected so the user explicitly
// chooses which template to render.
const TEMPLATE_SUFFIXES = ["-flow", "-bars"];
let slug = compositionId;
let templateSuffix = "";
for (const suf of TEMPLATE_SUFFIXES) {
  if (compositionId.endsWith(suf)) {
    slug = compositionId.slice(0, -suf.length);
    templateSuffix = suf;
    break;
  }
}
if (!templateSuffix) {
  console.error(
    `Composition id must end in -flow or -bars. Got: ${compositionId}`,
  );
  console.error(`  Try: npm run render ${compositionId}-bars`);
  process.exit(1);
}

const { episode } = await loadEpisode(slug);
const paths = episodePaths(slug);
const { root: ROOT, outDir: OUT_DIR } = paths;
// Output file mirrors the composition id so template variants don't overwrite
// each other in out/.
const OUT_FILE = path.join(OUT_DIR, `${slug}${templateSuffix}.mp4`);

const missing = episode.items.filter(
  (it) =>
    !it.imagePath || !existsSync(path.join(ROOT, "public", it.imagePath)),
);
if (missing.length > 0) {
  console.error(
    `${missing.length} item(s) missing local images. Run: npm run build-episode ${slug}`,
  );
  for (const it of missing) console.error(`  #${it.rank} ${it.title}`);
  process.exit(1);
}

await fs.mkdir(OUT_DIR, { recursive: true });

const args = [
  "remotion",
  "render",
  compositionId,
  OUT_FILE,
  "--codec=h264",
  "--crf=18",
  "--concurrency=1",
  // R3F can take >30s to recover after a browser restart on long renders.
  // 2-min per-handle timeout keeps the render alive across crashes.
  "--timeout=120000",
];

console.log(`Rendering ${compositionId} → ${path.relative(ROOT, OUT_FILE)}`);
const child = spawn("npx", args, { stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  console.log(`\nDone → ${path.relative(ROOT, OUT_FILE)}`);
});
