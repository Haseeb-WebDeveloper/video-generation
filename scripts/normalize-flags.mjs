#!/usr/bin/env node
// Regenerate every flag PNG in public/flags from its pristine .svg source at a
// UNIFORM HEIGHT, keeping the flag's natural width (no cropping, no padding).
//
// Why this shape: the slide templates render every cover at one fixed height
// (fitCoverDims in flow-slides.tsx: width = height × native aspect) inside a
// framed border. So a clean, consistent look needs flags that share a height
// and keep their true proportions — NOT flags squashed into one rectangle.
// Cropping to a common box cut the wide flags (e.g. Philippines 2:1 → 3:2) and
// padding to a common box bleeds white flags (Japan) into white bars. Uniform
// height sidesteps both: drop any flag straight into a video via
// "imagePath": "flags/xx.png" and it lines up with the rest, uncropped.
//
// Usage: node scripts/normalize-flags.mjs [--height=1024] [--dry-run]
//
// Sources the .svg (vector, lossless) so re-running never degrades quality.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FLAG_DIR = path.join(ROOT, "public", "flags");

const argv = process.argv.slice(2);
const opt = Object.fromEntries(
  argv
    .filter((a) => a.startsWith("--") && a.includes("="))
    .map((a) => a.slice(2).split("=")),
);
const dryRun = argv.includes("--dry-run");
const H = Number(opt.height ?? 1024);

const svgs = (await fs.readdir(FLAG_DIR)).filter((f) => /\.svg$/i.test(f));
let written = 0;
const failed = [];
const noSvg = [];

// Flags whose .png exists but has no .svg source — report so they can be
// re-fetched; we can't losslessly regenerate them here.
const pngs = new Set(
  (await fs.readdir(FLAG_DIR))
    .filter((f) => /\.png$/i.test(f))
    .map((f) => f.replace(/\.png$/i, "")),
);
for (const code of pngs) {
  if (!svgs.includes(`${code}.svg`)) noSvg.push(`${code}.png`);
}

for (const svg of svgs) {
  const code = svg.replace(/\.svg$/i, "");
  const outPath = path.join(FLAG_DIR, `${code}.png`);
  try {
    // density scales the SVG rasterization; high enough that the target
    // height is crisp for any source viewBox.
    const out = await sharp(path.join(FLAG_DIR, svg), { density: 384 })
      .resize({ height: H, fit: "inside", withoutEnlargement: false })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const meta = await sharp(out).metadata();
    if (dryRun) {
      console.log(`would write ${code}.png → ${meta.width}x${meta.height}`);
      written++;
      continue;
    }
    await fs.writeFile(outPath, out);
    written++;
  } catch (err) {
    failed.push(`${code}: ${err.message}`);
  }
}

console.log(
  `\nFlags: ${svgs.length} svg sources — ${written} ${dryRun ? "would regenerate" : "regenerated"} at height ${H}px (natural width, uncropped).`,
);
if (noSvg.length) {
  console.log(`\n${noSvg.length} png(s) have no .svg source (left as-is):`);
  console.log("  " + noSvg.join(", "));
}
if (failed.length) {
  console.log(`\n${failed.length} failed:`);
  for (const f of failed) console.log(`  ${f}`);
  process.exit(1);
}
