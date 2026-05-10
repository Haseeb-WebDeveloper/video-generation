#!/usr/bin/env node
// Download country flag PNGs from flagcdn.com into public/flags/<code>.png
// for every ISO code referenced by any episode. Idempotent — skips files
// that already exist.
//
// Usage:
//   node scripts/fetch-flags.mjs           // scan all episodes
//   node scripts/fetch-flags.mjs <slug>    // just one episode

import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FLAGS_DIR = path.join(ROOT, "public", "flags");
const EPISODES_DIR = path.join(ROOT, "episodes");

const UA = "VideoBuilder/1.0 (offline-render)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [, , onlySlug] = process.argv;

await fs.mkdir(FLAGS_DIR, { recursive: true });

const files = (await fs.readdir(EPISODES_DIR)).filter(
  (f) => f.endsWith(".json") && !f.endsWith(".published.json"),
);

const codes = new Set();
for (const f of files) {
  const slug = f.replace(/\.json$/, "");
  if (onlySlug && slug !== onlySlug) continue;
  const raw = await fs.readFile(path.join(EPISODES_DIR, f), "utf8");
  let ep;
  try {
    ep = JSON.parse(raw);
  } catch {
    continue;
  }
  for (const it of ep.items ?? []) {
    if (typeof it.country === "string" && it.country.length === 2) {
      codes.add(it.country.toLowerCase());
    }
  }
}

if (codes.size === 0) {
  console.log("No country codes found.");
  process.exit(0);
}

let downloaded = 0;
let skipped = 0;
let failed = 0;

for (const code of codes) {
  const dest = path.join(FLAGS_DIR, `${code}.png`);
  if (existsSync(dest)) {
    skipped++;
    continue;
  }
  const url = `https://flagcdn.com/w320/${code}.png`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    if (ab.byteLength < 80) throw new Error("response too small");
    await fs.writeFile(dest, Buffer.from(ab));
    downloaded++;
    console.log(`OK    ${code} → flags/${code}.png (${(ab.byteLength / 1024).toFixed(0)}KB)`);
    await sleep(400);
  } catch (err) {
    failed++;
    console.warn(`FAIL  ${code}: ${err.message}`);
  }
}

console.log(`\nDone. downloaded=${downloaded} skipped=${skipped} failed=${failed}`);
