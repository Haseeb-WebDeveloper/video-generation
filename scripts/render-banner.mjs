#!/usr/bin/env node
// Render the channel banner still (2560×1440) → public/banner.png.
// Usage: node scripts/render-banner.mjs [outPath]

import path from "node:path";
import fs from "node:fs/promises";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderStill } from "@remotion/renderer";

const root = path.resolve(process.cwd());
const outPath = path.resolve(root, process.argv[2] ?? "public/banner.png");
await fs.mkdir(path.dirname(outPath), { recursive: true });

console.log("Bundling…");
const serveUrl = await bundle({ entryPoint: path.join(root, "src", "index.ts") });

console.log("Rendering banner…");
const composition = await selectComposition({ serveUrl, id: "banner", inputProps: {} });
await renderStill({ serveUrl, composition, output: outPath, imageFormat: "png", overwrite: true });

const { size } = await fs.stat(outPath);
console.log(`Done → ${path.relative(root, outPath)} (${(size / 1024).toFixed(0)} KB, ${composition.width}×${composition.height})`);
