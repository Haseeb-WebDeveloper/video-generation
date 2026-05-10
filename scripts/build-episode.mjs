#!/usr/bin/env node
// Resolve all imageSource → local imagePath for one episode.
//
// Per item:
//   1. If imagePath already set AND the file exists, skip.
//   2. Else if imageSource URL set, download it.
//   3. Else look up Wikipedia summary by item.title and use originalimage.
//   4. Else warn and continue.
//
// Downloaded image is normalized (≤ 1024 longest side, JPG q85, sRGB) and
// saved to public/covers/<slug>/<rank>.jpg. The episode JSON is then
// rewritten with imagePath set.
//
// Usage: node scripts/build-episode.mjs <slug>

import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import sharp from "sharp";
import { removeBackground } from "@imgly/background-removal-node";
import { loadEpisode, writeEpisode } from "./lib/episode-loader.mjs";

const [, , slug] = process.argv;
if (!slug) {
  console.error("Usage: node scripts/build-episode.mjs <slug>");
  process.exit(1);
}

const { episode, paths } = await loadEpisode(slug);
const { root: ROOT, episodeFile: EPISODE_FILE, coversDir: COVERS_DIR } = paths;

const UA = "VideoBuilder/1.0 (offline-render)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-episode knob: "inside" preserves cover aspect (default), "contain" pads
// every cover to a 1024×1024 white square — used when covers are mixed-aspect
// logos that should render at uniform card size.
const COVER_FIT = episode.coverFit === "contain" ? "contain" : "inside";

await fs.mkdir(COVERS_DIR, { recursive: true });

let updated = false;
let misses = 0;

for (const item of episode.items) {
  const localPath = `covers/${slug}/${item.rank}.jpg`;
  const absLocal = path.join(ROOT, "public", localPath);

  if (item.imagePath && existsSync(path.join(ROOT, "public", item.imagePath))) {
    console.log(`SKIP  #${item.rank} (already at ${item.imagePath})`);
    continue;
  }

  let buf = null;
  let source = "";

  if (item.imageSource) {
    try {
      buf = await downloadAndNormalize(item.imageSource);
      source = `url:${item.imageSource}`;
    } catch (err) {
      console.warn(`  imageSource failed for #${item.rank}: ${err.message}`);
    }
  }

  if (!buf) {
    try {
      const wiki = await tryWikipedia(item.title);
      if (wiki) {
        buf = await downloadAndNormalize(wiki.url);
        source = `wiki:${wiki.title}`;
      }
    } catch (err) {
      console.warn(`  wikipedia failed for #${item.rank}: ${err.message}`);
    }
  }

  if (!buf) {
    console.log(`MISS  #${item.rank} ${item.title}`);
    misses++;
    await sleep(300);
    continue;
  }

  // Optional background removal — run before the flag composite so the flag
  // chip lands on a clean isolated subject. Per-item override beats the
  // episode-level flag.
  const wantBgRemoval = item.removeBg ?? episode.removeBg ?? false;
  if (wantBgRemoval) {
    try {
      buf = await applyBgRemoval(buf);
      source += " +nobg";
    } catch (err) {
      console.warn(`  bg removal failed for #${item.rank}: ${err.message}`);
    }
  }

  if (item.country) {
    try {
      buf = await compositeFlag(buf, item.country);
      source += ` +flag:${item.country}`;
    } catch (err) {
      console.warn(`  flag composite failed for #${item.rank}: ${err.message}`);
    }
  }

  await fs.writeFile(absLocal, buf);
  item.imagePath = localPath;
  updated = true;
  console.log(
    `OK    #${item.rank} ${source} → ${localPath} (${(buf.length / 1024).toFixed(0)}KB)`,
  );
  await sleep(1500);
}

// Optional thumbnail download. We only fetch when thumbnailSource is set and
// thumbnailPath isn't already pointing at an existing local file. Re-running
// build never clobbers a thumbnail you've already authored or upscaled.
if (episode.thumbnailSource) {
  const wantPath = `thumbnails/${slug}.jpg`;
  const absWant = path.join(ROOT, "public", wantPath);
  const haveLocal =
    episode.thumbnailPath &&
    existsSync(path.join(ROOT, "public", episode.thumbnailPath));
  if (haveLocal) {
    console.log(`SKIP  thumbnail (already at ${episode.thumbnailPath})`);
  } else {
    try {
      await fs.mkdir(path.dirname(absWant), { recursive: true });
      const buf = await downloadAndNormalize(episode.thumbnailSource);
      await fs.writeFile(absWant, buf);
      episode.thumbnailPath = wantPath;
      updated = true;
      console.log(
        `OK    thumbnail url:${episode.thumbnailSource} → ${wantPath} (${(buf.length / 1024).toFixed(0)}KB)`,
      );
      console.log(
        `      Tip: run "npm run upscale -- public/${wantPath}" to produce a 4K master.`,
      );
    } catch (err) {
      console.warn(`  thumbnail download failed: ${err.message}`);
    }
  }
}

if (updated) {
  await writeEpisode(slug, episode);
  console.log(`\nUpdated ${path.relative(ROOT, EPISODE_FILE)}`);
}
console.log(
  `\nDone. ${episode.items.length - misses}/${episode.items.length} items have local images.`,
);
if (misses > 0) {
  console.log(
    `${misses} items still missing — add an "imageSource" URL to those entries in the JSON and re-run.`,
  );
  process.exitCode = 2;
}

async function downloadAndNormalize(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  if (ab.byteLength < 2000) throw new Error("response too small");
  const img = sharp(Buffer.from(ab), { density: 384 });
  if (COVER_FIT === "contain") {
    // Pad to a square canvas so mixed-aspect covers render at uniform size.
    return img
      .resize({
        width: 1024,
        height: 1024,
        fit: "contain",
        background: "#ffffff",
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 90, mozjpeg: true })
      .withMetadata()
      .toBuffer();
  }
  // Default: preserve aspect, no padding (the original behavior).
  return img
    .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85, mozjpeg: true })
    .withMetadata()
    .toBuffer();
}

// Strip the background, then composite the cutout onto a white square. This
// gives covers a clean studio-lookbook feel — every subject sits on the
// same neutral backdrop, which reads as premium in the 3D scene.
async function applyBgRemoval(buf) {
  const blob = new Blob([buf], { type: "image/jpeg" });
  const resultBlob = await removeBackground(blob);
  const cutoutBuf = Buffer.from(await resultBlob.arrayBuffer());

  const meta = await sharp(cutoutBuf).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const side = Math.max(w, h);

  return sharp({
    create: {
      width: side,
      height: side,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      {
        input: cutoutBuf,
        top: Math.round((side - h) / 2),
        left: Math.round((side - w) / 2),
      },
    ])
    .flatten({ background: "#ffffff" })
    .resize({
      width: 1024,
      height: 1024,
      fit: "contain",
      background: "#ffffff",
    })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
}

// Compose a small country flag chip in the upper-right of the cover. The flag
// PNG is fetched from flagcdn.com keyed by ISO 3166-1 alpha-2 code.
async function compositeFlag(coverBuf, country) {
  const code = country.toLowerCase();
  const flagUrl = `https://flagcdn.com/w320/${code}.png`;
  const res = await fetch(flagUrl, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`flagcdn HTTP ${res.status}`);
  const flagAb = await res.arrayBuffer();
  // Simple horizontal-stripe flags (DE, RU, FR) compress to ~150 bytes — that's
  // legitimate, not an error response. 80 is a safe floor for any real PNG.
  if (flagAb.byteLength < 80) throw new Error("flag response too small");

  const meta = await sharp(coverBuf).metadata();
  const flagH = Math.round(meta.height * 0.1); // ~10% of cover height
  const flagResized = await sharp(Buffer.from(flagAb))
    .resize({ height: flagH, fit: "contain" })
    .png()
    .toBuffer();
  const fmeta = await sharp(flagResized).metadata();

  // Add a subtle 2px dark border around the flag so it reads against any logo.
  const border = 2;
  const flagWithBorder = await sharp({
    create: {
      width: fmeta.width + border * 2,
      height: fmeta.height + border * 2,
      channels: 4,
      background: { r: 30, g: 30, b: 30, alpha: 1 },
    },
  })
    .composite([{ input: flagResized, top: border, left: border }])
    .png()
    .toBuffer();
  const fbm = await sharp(flagWithBorder).metadata();

  const margin = Math.round(meta.height * 0.025);
  return sharp(coverBuf)
    .composite([
      {
        input: flagWithBorder,
        top: margin,
        left: meta.width - fbm.width - margin,
      },
    ])
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

async function tryWikipedia(title) {
  const slug = encodeURIComponent(title.replace(/ /g, "_"));
  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`;
  const res = await fetch(summaryUrl, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const json = await res.json();
  const url = json?.originalimage?.source ?? json?.thumbnail?.source;
  if (!url) return null;
  return { url, title: json.title ?? title };
}
