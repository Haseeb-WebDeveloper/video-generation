#!/usr/bin/env node
// Upscale any image to ~4K (3840 px on the long side) using Real-ESRGAN
// ncnn-vulkan. Uses the GPU via Vulkan when available; CPU fallback works
// but is slower.
//
// Usage:
//   node scripts/upscale-image.mjs <input> [output]
//   npm run upscale -- <input> [output]
//
// Default output: <input-without-ext>.4k.jpg next to the source. Output
// extension can be .jpg or .png; .jpg is recommended for thumbnails.
//
// One-time setup: download realesrgan-ncnn-vulkan-XXXX-windows.zip from
//   https://github.com/xinntao/Real-ESRGAN/releases
// and unzip into <repo>/tools/realesrgan/. The script also accepts the
// binary on PATH as `realesrgan-ncnn-vulkan`.

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import sharp from "sharp";

const TARGET_LONG_SIDE = 3840; // 4K UHD

const [, , inputArg, outputArg] = process.argv;
if (!inputArg) {
  console.error("Usage: node scripts/upscale-image.mjs <input> [output]");
  process.exit(1);
}

const ROOT = path.resolve(process.cwd());
const input = path.resolve(inputArg);
if (!existsSync(input)) {
  console.error(`Input not found: ${input}`);
  process.exit(1);
}

const output = path.resolve(outputArg ?? defaultOutputPath(input));
await fs.mkdir(path.dirname(output), { recursive: true });

const inputMeta = await sharp(input).metadata();
const inLong = Math.max(inputMeta.width ?? 0, inputMeta.height ?? 0);
console.log(
  `Input: ${path.relative(ROOT, input)} (${inputMeta.width}×${inputMeta.height}, ${inputMeta.format})`,
);

if (inLong >= TARGET_LONG_SIDE) {
  console.log(
    `Source is already ≥ ${TARGET_LONG_SIDE}px on the long side — no AI upscale needed.`,
  );
  await sharp(input)
    .rotate()
    .resize({
      width: TARGET_LONG_SIDE,
      height: TARGET_LONG_SIDE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(output);
  console.log(`Wrote ${path.relative(ROOT, output)}`);
  process.exit(0);
}

const bin = await locateBinary(ROOT);
if (!bin) {
  printInstallInstructions();
  process.exit(1);
}
console.log(`Engine: ${path.relative(ROOT, bin)}`);

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "upscale-"));
const tmpOut = path.join(tmpDir, "upscaled.png");

try {
  await runRealEsrgan(bin, input, tmpOut);
  const upMeta = await sharp(tmpOut).metadata();
  const upLong = Math.max(upMeta.width ?? 0, upMeta.height ?? 0);
  console.log(`AI upscaled to ${upMeta.width}×${upMeta.height}.`);

  let pipeline = sharp(tmpOut).rotate();
  if (upLong > TARGET_LONG_SIDE) {
    pipeline = pipeline.resize({
      width: TARGET_LONG_SIDE,
      height: TARGET_LONG_SIDE,
      fit: "inside",
    });
  }
  const ext = path.extname(output).toLowerCase();
  if (ext === ".png") {
    await pipeline.png({ compressionLevel: 9 }).toFile(output);
  } else {
    await pipeline.jpeg({ quality: 92, mozjpeg: true }).toFile(output);
  }
  const finalMeta = await sharp(output).metadata();
  const finalStat = await fs.stat(output);
  console.log(
    `Wrote ${path.relative(ROOT, output)} (${finalMeta.width}×${finalMeta.height}, ${(finalStat.size / 1024).toFixed(0)}KB)`,
  );
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}

// ───────────────────────────────────────────────────────────────────────────

function defaultOutputPath(inputPath) {
  const ext = path.extname(inputPath);
  const base = inputPath.slice(0, -ext.length);
  return `${base}.4k.jpg`;
}

async function locateBinary(root) {
  const candidates = [
    path.join(root, "tools", "realesrgan", "realesrgan-ncnn-vulkan.exe"),
    path.join(root, "tools", "realesrgan", "realesrgan-ncnn-vulkan"),
    path.join(
      root,
      "tools",
      "realesrgan-ncnn-vulkan",
      "realesrgan-ncnn-vulkan.exe",
    ),
    path.join(root, "tools", "realesrgan-ncnn-vulkan", "realesrgan-ncnn-vulkan"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Fall back to PATH lookup (where on win, which on posix).
  const pathBin = await whichBinary("realesrgan-ncnn-vulkan");
  if (pathBin) return pathBin;
  return null;
}

function whichBinary(name) {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32" ? "where" : "which";
    const child = spawn(cmd, [name], { shell: false });
    let out = "";
    child.stdout.on("data", (b) => (out += b.toString()));
    child.on("error", () => resolve(null));
    child.on("exit", (code) => {
      if (code !== 0) return resolve(null);
      const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      resolve(first || null);
    });
  });
}

function runRealEsrgan(bin, input, output) {
  return new Promise((resolve, reject) => {
    const args = [
      "-i", input,
      "-o", output,
      "-n", "realesrgan-x4plus",
      "-s", "4",
      "-f", "png",
    ];
    const child = spawn(bin, args, {
      cwd: path.dirname(bin),
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`realesrgan-ncnn-vulkan exited with code ${code}`));
    });
  });
}

function printInstallInstructions() {
  const root = process.cwd();
  console.error(`
Real-ESRGAN binary not found.

One-time setup:
  1. Open https://github.com/xinntao/Real-ESRGAN/releases
  2. Download the latest realesrgan-ncnn-vulkan-XXXX-windows.zip (~50MB)
  3. Unzip its contents into:
       ${path.join(root, "tools", "realesrgan")}
  4. After unzipping, this file must exist:
       ${path.join(root, "tools", "realesrgan", "realesrgan-ncnn-vulkan.exe")}
     and the models/ folder must sit next to it.
  5. Re-run: npm run upscale -- <input> [output]

The binary uses Vulkan — works on integrated and discrete GPUs.
No model downloads needed; everything ships in the zip.
`);
}
