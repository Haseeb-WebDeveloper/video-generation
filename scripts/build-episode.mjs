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

const [, , slug] = process.argv;
if (!slug) {
  console.error("Usage: node scripts/build-episode.mjs <slug>");
  process.exit(1);
}

const ROOT = path.resolve(process.cwd());
const EPISODE_FILE = path.join(ROOT, "episodes", `${slug}.json`);
const COVERS_DIR = path.join(ROOT, "public", "covers", slug);

const UA = "VideoBuilder/1.0 (offline-render)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const raw = await fs.readFile(EPISODE_FILE, "utf-8");
const episode = JSON.parse(raw);

if (episode.slug !== slug) {
  console.error(
    `Episode slug mismatch: file has "${episode.slug}", argv has "${slug}".`,
  );
  process.exit(1);
}

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

  await fs.writeFile(absLocal, buf);
  item.imagePath = localPath;
  updated = true;
  console.log(
    `OK    #${item.rank} ${source} → ${localPath} (${(buf.length / 1024).toFixed(0)}KB)`,
  );
  await sleep(300);
}

if (updated) {
  await fs.writeFile(EPISODE_FILE, JSON.stringify(episode, null, 2) + "\n");
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
  return sharp(Buffer.from(ab))
    .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .withMetadata()
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
