#!/usr/bin/env node
// Strip the background from an image using @imgly/background-removal-node.
// Runs entirely offline once the ONNX model is cached (first run downloads
// ~80MB into node_modules).
//
// Usage:
//   node scripts/remove-bg.mjs <input> [output]
//   npm run remove-bg -- <input> [output]
//
// Default output:
//   <input-without-ext>.nobg.png       transparent PNG (matches input aspect)
//
// Pass `--composite=white` (or any hex color) to flatten the result onto a
// solid square background — useful for covers that ship as JPGs into the
// existing 3D templates.
//
//   node scripts/remove-bg.mjs in.jpg out.jpg --composite=white
//   node scripts/remove-bg.mjs in.jpg out.jpg --composite=#0a0a14

import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import sharp from "sharp";
import { removeBackground } from "@imgly/background-removal-node";

const args = process.argv.slice(2);
const positional = [];
const flags = {};
for (const a of args) {
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  } else positional.push(a);
}
const [inputArg, outputArg] = positional;

if (!inputArg) {
  console.error(
    "Usage: node scripts/remove-bg.mjs <input> [output] [--composite=white|#hex]",
  );
  process.exit(1);
}

const ROOT = path.resolve(process.cwd());
const input = path.resolve(inputArg);
if (!existsSync(input)) {
  console.error(`Input not found: ${input}`);
  process.exit(1);
}

const composite = typeof flags.composite === "string" ? flags.composite : null;
const output = path.resolve(outputArg ?? defaultOutputPath(input, composite));
await fs.mkdir(path.dirname(output), { recursive: true });

const inputMeta = await sharp(input).metadata();
console.log(
  `Input: ${path.relative(ROOT, input)} (${inputMeta.width}×${inputMeta.height}, ${inputMeta.format})`,
);

const inputBuf = await fs.readFile(input);
const inputExt = path.extname(input).toLowerCase();
const inputMime =
  inputExt === ".png"
    ? "image/png"
    : inputExt === ".webp"
      ? "image/webp"
      : "image/jpeg";
const blob = new Blob([inputBuf], { type: inputMime });
console.log("Removing background…");
const t0 = Date.now();
const resultBlob = await removeBackground(blob);
const cutoutBuf = Buffer.from(await resultBlob.arrayBuffer());
console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

let pipeline = sharp(cutoutBuf);

if (composite) {
  // Composite onto a solid square so JPG output keeps consistent framing
  // across all items in an episode.
  const cutoutMeta = await sharp(cutoutBuf).metadata();
  const w = cutoutMeta.width ?? 0;
  const h = cutoutMeta.height ?? 0;
  const side = Math.max(w, h);
  const bg = parseColor(composite);
  pipeline = sharp({
    create: {
      width: side,
      height: side,
      channels: 3,
      background: bg,
    },
  })
    .composite([
      {
        input: cutoutBuf,
        top: Math.round((side - h) / 2),
        left: Math.round((side - w) / 2),
      },
    ])
    .flatten({ background: bg });
}

const ext = path.extname(output).toLowerCase();
if (ext === ".jpg" || ext === ".jpeg") {
  if (!composite) {
    // Transparent → JPG without composite would just dump black; force white.
    pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
  }
  await pipeline.jpeg({ quality: 92, mozjpeg: true }).toFile(output);
} else {
  await pipeline.png({ compressionLevel: 9 }).toFile(output);
}

const finalMeta = await sharp(output).metadata();
const finalStat = await fs.stat(output);
console.log(
  `Wrote ${path.relative(ROOT, output)} (${finalMeta.width}×${finalMeta.height}, ${(finalStat.size / 1024).toFixed(0)}KB)`,
);

// ───────────────────────────────────────────────────────────────────────────

function defaultOutputPath(inputPath, hasComposite) {
  const ext = path.extname(inputPath);
  const base = inputPath.slice(0, -ext.length);
  return hasComposite ? `${base}.nobg.jpg` : `${base}.nobg.png`;
}

function parseColor(spec) {
  if (spec === "white") return { r: 255, g: 255, b: 255 };
  if (spec === "black") return { r: 0, g: 0, b: 0 };
  const m = spec.match(/^#?([0-9a-f]{6})$/i);
  if (m) {
    const hex = m[1];
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  const m3 = spec.match(/^#?([0-9a-f]{3})$/i);
  if (m3) {
    const hex = m3[1];
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
    };
  }
  throw new Error(`Unrecognized color: ${spec}`);
}
