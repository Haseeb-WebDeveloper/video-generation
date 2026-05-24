#!/usr/bin/env node
// Generate a month of SINGLE-BATTLE episodes (10 popular-market countries each)
// for the "one quick battle per upload" format. Each video features the biggest
// YouTube audiences (India, USA, Pakistan, Indonesia, Brazil, UK, ...) so the
// algorithm surfaces it to those viewers — who'll want to see their flag win.
//
// Writes episodes/<slug>.json with template:"battle" + a YouTube SEO block (no
// {{chapters}} — a single battle has none). Does NOT bake; run battle-roll per
// slug afterward, then schedule-batch.
//
// Usage:
//   node scripts/make-monthly-singles.mjs          # write all 10 episodes
//   node scripts/make-monthly-singles.mjs --check  # validate only (no writes)

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const FLAGS_DIR = path.join(ROOT, "public", "flags");
const EPISODES_DIR = path.join(ROOT, "episodes");
const checkOnly = process.argv.includes("--check");

const NAMES = {
  in: "India", us: "United States", pk: "Pakistan", id: "Indonesia",
  br: "Brazil", mx: "Mexico", gb: "United Kingdom", bd: "Bangladesh",
  ph: "Philippines", jp: "Japan", ru: "Russia", tr: "Turkey", vn: "Vietnam",
  eg: "Egypt", ng: "Nigeria", de: "Germany", kr: "South Korea",
  sa: "Saudi Arabia", fr: "France", th: "Thailand", es: "Spain",
  ar: "Argentina", co: "Colombia", it: "Italy", za: "South Africa",
  ca: "Canada", my: "Malaysia",
};

const C = (s) => s.split(/\s+/).filter(Boolean);

// 10 sets of 10 — each features major YouTube markets, varied across the month.
const SETS = [
  C("in us pk gb br id mx jp de ng"),
  C("in us pk bd ph id br ru tr eg"),
  C("in us pk gb fr de es kr sa tr"),
  C("in us br mx ar co id ph vn th"),
  C("in us pk bd ng eg sa id tr br"),
  C("us gb de fr es it ru jp kr br"),
  C("in pk bd id ph vn th my jp kr"),
  C("us mx br ar co ca gb es in id"),
  C("in us pk ng eg za id br tr sa"),
  C("in us pk gb id br mx jp de ru"),
];

const AUDIO = "audio/When The Smoke Clears - Evening Telecast.mp3";
const BASE_TAGS = [
  "spinning top battle", "marble race", "country battle", "countries battle",
  "last one standing", "satisfying", "physics simulation", "beyblade battle",
  "flag battle", "elimination", "who will win", "spinning top",
];

function buildEpisode(codes, idx) {
  const slug = `spin-${String(idx + 1).padStart(2, "0")}`;
  const items = codes.map((c) => ({
    title: NAMES[c],
    value: 1,
    country: c.toUpperCase(),
    imagePath: `flags/${c}.png`,
  }));
  const names = items.map((i) => i.title);
  const title = `Spinning Top Battle 🌍 ${names.slice(0, 3).join(", ")} & ${
    names.length - 3
  } more — Who Wins?`.slice(0, 100);
  const description = [
    `${names.length} countries enter the arena as spinning tops — ${names.join(", ")}.`,
    `They clash and knock each other's spin out, falling one by one. The LAST top still spinning WINS! 🏆`,
    ``,
    `Which country are you backing? 👇`,
    ``,
    `#spinningtop #marblerace #countrybattle #satisfying`,
  ].join("\n");
  return {
    slug,
    template: "battle",
    title: ["SPINNING TOP BATTLE", "LAST ONE WINS"],
    outro: ["WHICH COUNTRY DID YOU BACK?", "Like & subscribe for more"],
    unitLabel: "",
    coverFit: "cover",
    compositeFlagOnCover: false,
    audioPath: AUDIO,
    audioVolume: 0.3,
    items,
    youtube: {
      title,
      description,
      tags: [...BASE_TAGS, ...names],
      categoryId: "24",
      privacyStatus: "private",
      madeForKids: false,
      defaultLanguage: "en",
    },
  };
}

// ── Validate ──
let problems = 0;
const slugs = [];
SETS.forEach((codes, i) => {
  const slug = `spin-${String(i + 1).padStart(2, "0")}`;
  slugs.push(slug);
  if (codes.length !== 10) {
    console.error(`✗ ${slug}: ${codes.length} codes (need 10)`);
    problems++;
  }
  const dupes = codes.filter((c, j) => codes.indexOf(c) !== j);
  if (dupes.length) {
    console.error(`✗ ${slug}: duplicate ${[...new Set(dupes)].join(", ")}`);
    problems++;
  }
  for (const c of codes) {
    if (!NAMES[c]) { console.error(`✗ ${slug}: no name for "${c}"`); problems++; }
    if (!existsSync(path.join(FLAGS_DIR, `${c}.png`))) {
      console.error(`✗ ${slug}: missing flag flags/${c}.png`); problems++;
    }
  }
});
if (problems > 0) {
  console.error(`\n${problems} problem(s) — nothing written.`);
  process.exit(1);
}
console.log(`✓ All ${SETS.length} single-battle sets valid (10 unique codes, flags present).`);
if (checkOnly) {
  console.log(`\nSlugs:\n  ${slugs.join(" ")}`);
  process.exit(0);
}

// ── Write ──
await fs.mkdir(EPISODES_DIR, { recursive: true });
for (let i = 0; i < SETS.length; i++) {
  const ep = buildEpisode(SETS[i], i);
  await fs.writeFile(path.join(EPISODES_DIR, `${ep.slug}.json`), JSON.stringify(ep, null, 2) + "\n");
  console.log(`wrote episodes/${ep.slug}.json  (${ep.items.length} countries)`);
}
console.log(`\nNext:`);
console.log(`  for s in ${slugs.join(" ")}; do node scripts/battle-roll.mjs $s --candidates=6; done`);
console.log(`  node scripts/schedule-batch.mjs --start=<ISO-UTC> --every=3 ${slugs.join(" ")}`);
