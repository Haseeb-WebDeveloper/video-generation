#!/usr/bin/env node
// Render the spin-battle thumbnail stills. Bundles the Remotion project ONCE
// and renders every <slug>-spin-thumb composition to public/thumbnails/<slug>.png
// at the composition's own resolution (2560×1440). Much faster than calling
// `npx remotion still` per slug (which re-bundles each time).
//
// Usage:
//   node scripts/render-thumbs.mjs                  # all spin-01..10
//   node scripts/render-thumbs.mjs spin-03 spin-07  # specific slugs

import path from "node:path";
import fs from "node:fs/promises";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderStill } from "@remotion/renderer";

const root = path.resolve(process.cwd());
const args = process.argv.slice(2);
const slugs =
  args.filter((a) => !a.startsWith("--")).length > 0
    ? args.filter((a) => !a.startsWith("--"))
    : Array.from({ length: 10 }, (_, i) => `spin-${String(i + 1).padStart(2, "0")}`);

const outDir = path.join(root, "public", "thumbnails");
await fs.mkdir(outDir, { recursive: true });

console.log(`Bundling Remotion project…`);
const serveUrl = await bundle({
  entryPoint: path.join(root, "src", "index.ts"),
  // Keep the default webpack config the studio uses.
});
console.log(`Bundle ready.\n`);

for (const slug of slugs) {
  const id = `${slug}-spin-thumb`;
  const outPath = path.join(outDir, `${slug}.png`);
  process.stdout.write(`Rendering ${id} → public/thumbnails/${slug}.png … `);
  try {
    const composition = await selectComposition({
      serveUrl,
      id,
      inputProps: {},
    });
    await renderStill({
      serveUrl,
      composition,
      output: outPath,
      imageFormat: "png",
      overwrite: true,
    });
    const { size } = await fs.stat(outPath);
    console.log(`done (${(size / 1024).toFixed(0)} KB, ${composition.width}×${composition.height})`);
  } catch (err) {
    console.log(`FAILED`);
    console.error(`  ${err.message}`);
  }
}

console.log(`\nAll thumbnails written to public/thumbnails/`);
