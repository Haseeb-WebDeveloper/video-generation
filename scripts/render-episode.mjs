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

const [, , slug] = process.argv;
if (!slug) {
  console.error("Usage: node scripts/render-episode.mjs <slug>");
  process.exit(1);
}

const ROOT = path.resolve(process.cwd());
const EPISODE_FILE = path.join(ROOT, "episodes", `${slug}.json`);
if (!existsSync(EPISODE_FILE)) {
  console.error(`Episode JSON not found: ${EPISODE_FILE}`);
  process.exit(1);
}

const episode = JSON.parse(await fs.readFile(EPISODE_FILE, "utf-8"));

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

const OUT_DIR = path.join(ROOT, "out");
await fs.mkdir(OUT_DIR, { recursive: true });
const OUT_FILE = path.join(OUT_DIR, `${slug}.mp4`);

const args = [
  "remotion",
  "render",
  slug,
  OUT_FILE,
  "--codec=h264",
  "--crf=18",
  "--concurrency=1",
];

console.log(`Rendering ${slug} → ${path.relative(ROOT, OUT_FILE)}`);
const child = spawn("npx", args, { stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  console.log(`\nDone → ${path.relative(ROOT, OUT_FILE)}`);
});
