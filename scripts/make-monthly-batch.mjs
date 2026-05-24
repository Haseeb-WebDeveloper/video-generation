#!/usr/bin/env node
// Generate a month's worth of tournament episodes (10 themed 40-country sets).
//
// Writes episodes/<slug>.json for each theme with the standard scaffold + a
// themed `youtube` SEO block (no spoilers). Does NOT bake — run tournament-roll
// per slug afterward to add tournamentSeed + tournamentResult + bakes, then
// schedule-batch to stamp publishAt.
//
// Idempotent: re-running overwrites the episode scaffolds but tournament-roll
// preserves a hand-authored youtube block (it only generates when missing).
//
// Usage:
//   node scripts/make-monthly-batch.mjs            # write all 10 episodes
//   node scripts/make-monthly-batch.mjs --check    # validate only (no writes)

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const FLAGS_DIR = path.join(ROOT, "public", "flags");
const EPISODES_DIR = path.join(ROOT, "episodes");
const checkOnly = process.argv.includes("--check");

// iso2 → display name (union of every code used across the themes below).
const NAMES = {
  // Europe
  al: "Albania", ad: "Andorra", at: "Austria", by: "Belarus", be: "Belgium",
  ba: "Bosnia and Herzegovina", bg: "Bulgaria", hr: "Croatia", cy: "Cyprus",
  cz: "Czechia", dk: "Denmark", ee: "Estonia", fi: "Finland", fr: "France",
  de: "Germany", gr: "Greece", hu: "Hungary", is: "Iceland", ie: "Ireland",
  it: "Italy", lv: "Latvia", li: "Liechtenstein", lt: "Lithuania",
  lu: "Luxembourg", mt: "Malta", md: "Moldova", mc: "Monaco", me: "Montenegro",
  nl: "Netherlands", mk: "North Macedonia", no: "Norway", pl: "Poland",
  pt: "Portugal", ro: "Romania", rs: "Serbia", sk: "Slovakia", si: "Slovenia",
  es: "Spain", se: "Sweden", ch: "Switzerland", ua: "Ukraine",
  gb: "United Kingdom", ru: "Russia",
  // Asia
  af: "Afghanistan", am: "Armenia", az: "Azerbaijan", bh: "Bahrain",
  bd: "Bangladesh", bt: "Bhutan", bn: "Brunei", kh: "Cambodia", cn: "China",
  ge: "Georgia", in: "India", id: "Indonesia", ir: "Iran", iq: "Iraq",
  il: "Israel", jp: "Japan", jo: "Jordan", kz: "Kazakhstan", kw: "Kuwait",
  kg: "Kyrgyzstan", la: "Laos", lb: "Lebanon", my: "Malaysia", mv: "Maldives",
  mn: "Mongolia", mm: "Myanmar", np: "Nepal", kp: "North Korea", om: "Oman",
  pk: "Pakistan", ph: "Philippines", qa: "Qatar", sa: "Saudi Arabia",
  sg: "Singapore", kr: "South Korea", lk: "Sri Lanka", sy: "Syria",
  tw: "Taiwan", tj: "Tajikistan", th: "Thailand", tr: "Turkey",
  ae: "United Arab Emirates", vn: "Vietnam", ye: "Yemen",
  // Africa
  dz: "Algeria", ao: "Angola", bj: "Benin", bw: "Botswana", bf: "Burkina Faso",
  bi: "Burundi", cm: "Cameroon", cv: "Cape Verde", td: "Chad",
  cd: "DR Congo", cg: "Congo", ci: "Côte d'Ivoire", dj: "Djibouti",
  eg: "Egypt", gq: "Equatorial Guinea", et: "Ethiopia", ga: "Gabon",
  gm: "Gambia", gh: "Ghana", gn: "Guinea", ke: "Kenya", ls: "Lesotho",
  lr: "Liberia", ly: "Libya", mg: "Madagascar", mw: "Malawi", ml: "Mali",
  mr: "Mauritania", mu: "Mauritius", ma: "Morocco", mz: "Mozambique",
  na: "Namibia", ne: "Niger", ng: "Nigeria", rw: "Rwanda", sn: "Senegal",
  so: "Somalia", za: "South Africa", tz: "Tanzania", tn: "Tunisia",
  ug: "Uganda", sd: "Sudan", sc: "Seychelles", km: "Comoros",
  st: "São Tomé and Príncipe",
  // Americas
  ar: "Argentina", bs: "Bahamas", bb: "Barbados", bz: "Belize", bo: "Bolivia",
  br: "Brazil", ca: "Canada", cl: "Chile", co: "Colombia", cr: "Costa Rica",
  cu: "Cuba", dm: "Dominica", do: "Dominican Republic", ec: "Ecuador",
  sv: "El Salvador", gd: "Grenada", gt: "Guatemala", gy: "Guyana",
  ht: "Haiti", hn: "Honduras", jm: "Jamaica", mx: "Mexico", ni: "Nicaragua",
  pa: "Panama", py: "Paraguay", pe: "Peru", kn: "Saint Kitts and Nevis",
  lc: "Saint Lucia", vc: "Saint Vincent", sr: "Suriname",
  tt: "Trinidad and Tobago", us: "United States", uy: "Uruguay",
  ve: "Venezuela", ag: "Antigua and Barbuda", aw: "Aruba",
  pr: "Puerto Rico", gp: "Guadeloupe", mq: "Martinique", bm: "Bermuda",
  // Oceania / islands
  au: "Australia", nz: "New Zealand", fj: "Fiji", pg: "Papua New Guinea",
  sb: "Solomon Islands", vu: "Vanuatu", ws: "Samoa", to: "Tonga",
  ki: "Kiribati", fm: "Micronesia", mh: "Marshall Islands", pw: "Palau",
  nr: "Nauru", tv: "Tuvalu",
};

const C = (s) => s.split(/\s+/).filter(Boolean);

const THEMES = [
  {
    slug: "europe-cup",
    titleLines: ["SPINNING TOP", "EUROPE CUP"],
    noun: "European countries",
    title: "European Spinning Top Battle 🇪🇺 40 Countries — Last One Spinning Wins!",
    hashtags: "#spinningtop #europe #marblerace #satisfying",
    extraTags: ["europe", "european countries", "eu battle"],
    codes: C(`al ad at by be ba bg hr cy cz dk ee fi fr de gr hu is ie it
              lv li lt lu mt md mc me nl mk no pl pt ro rs sk si es se ch`),
  },
  {
    slug: "asia-cup",
    titleLines: ["SPINNING TOP", "ASIA CUP"],
    noun: "Asian countries",
    title: "Asian Spinning Top Battle 🌏 40 Countries — Last One Spinning Wins!",
    hashtags: "#spinningtop #asia #marblerace #satisfying",
    extraTags: ["asia", "asian countries", "asia battle"],
    codes: C(`af am az bh bd bt bn kh cn ge in id ir iq il jp jo kz kw kg
              la lb my mv mn mm np kp om pk ph qa sa sg kr lk sy tw tj th`),
  },
  {
    slug: "africa-cup",
    titleLines: ["SPINNING TOP", "AFRICA CUP"],
    noun: "African countries",
    title: "African Spinning Top Battle 🌍 40 Countries — Last One Spinning Wins!",
    hashtags: "#spinningtop #africa #marblerace #satisfying",
    extraTags: ["africa", "african countries", "africa battle"],
    codes: C(`dz ao bj bw bf bi cm cv td cd cg ci dj eg gq et ga gm gh gn
              ke ls lr ly mg mw ml mr mu ma mz na ne ng rw sn so za tz tn`),
  },
  {
    slug: "americas-cup",
    titleLines: ["SPINNING TOP", "AMERICAS CUP"],
    noun: "countries of the Americas",
    title: "Americas Spinning Top Battle 🌎 40 Countries — Last One Spinning Wins!",
    hashtags: "#spinningtop #americas #marblerace #satisfying",
    extraTags: ["americas", "north america", "south america", "latin america"],
    codes: C(`ar bs bb bz bo br ca cl co cr cu dm do ec sv gd gt gy ht hn
              jm mx ni pa py pe kn lc vc sr tt us uy ve ag aw pr gp mq bm`),
  },
  {
    slug: "island-nations",
    titleLines: ["SPINNING TOP", "ISLAND NATIONS"],
    noun: "island nations",
    title: "Island Nations Spinning Top Battle 🏝️ 40 Countries — Last One Wins!",
    hashtags: "#spinningtop #islands #marblerace #satisfying",
    extraTags: ["island nations", "islands", "oceania", "caribbean"],
    codes: C(`jp gb id ph nz ie is cu jm mg lk mv mt cy fj pg sb vu ws to
              ki fm mh pw nr tv bs bb tt dm lc gd vc kn ag sc mu km cv st`),
  },
  {
    slug: "most-populous",
    titleLines: ["SPINNING TOP", "MOST POPULOUS"],
    noun: "of the world's most populous countries",
    title: "World's Most Populous Countries — Spinning Top Battle 🌍 Top 40!",
    hashtags: "#spinningtop #countries #marblerace #satisfying",
    extraTags: ["most populous countries", "population", "biggest countries"],
    codes: C(`in cn us id pk ng br bd ru et mx jp eg ph cd vn ir tr de th
              gb fr tz za it ke mm co kr sd ug es dz iq ar af ye ca pl ma`),
  },
  {
    slug: "top-economies",
    titleLines: ["SPINNING TOP", "TOP ECONOMIES"],
    noun: "of the world's biggest economies",
    title: "Biggest Economies Spinning Top Battle 💰 40 Countries — Last One Wins!",
    hashtags: "#spinningtop #economy #marblerace #satisfying",
    extraTags: ["biggest economies", "gdp", "richest countries"],
    codes: C(`us cn de jp in gb fr it br ca ru mx au kr es id nl tr sa ch
              pl tw be ar se ie th no ae il sg ng eg za ph dk my vn bd at`),
  },
  {
    slug: "football-giants",
    titleLines: ["SPINNING TOP", "FOOTBALL NATIONS"],
    noun: "football nations",
    title: "Football Nations Spinning Top Battle ⚽ 40 Countries — Last One Wins!",
    hashtags: "#spinningtop #football #soccer #marblerace",
    extraTags: ["football", "soccer", "world cup", "football nations"],
    codes: C(`br ar fr de es it pt nl be hr gb uy co mx us jp kr sn ma gh
              ng cm ci dz eg tn au ir sa qa ec py cl pe rs ch dk se pl cz`),
  },
  {
    slug: "world-powers",
    titleLines: ["SPINNING TOP", "WORLD POWERS"],
    noun: "world powers",
    title: "World Powers Spinning Top Battle 🌍 40 Countries — Last One Spinning Wins!",
    hashtags: "#spinningtop #countries #marblerace #satisfying",
    extraTags: ["world powers", "superpowers", "g20", "countries battle"],
    codes: C(`us ru cn gb fr de jp in br ca it kr au es mx id sa tr za ng
              eg ar pl nl se ch be no at ae il sg ir pk ua gr pt ie dk fi`),
  },
  {
    slug: "flags-of-the-world",
    titleLines: ["SPINNING TOP", "FLAGS OF THE WORLD"],
    noun: "flags from around the world",
    title: "Flags of the World Spinning Top Battle 🌍 40 Countries — Last One Wins!",
    hashtags: "#spinningtop #flags #marblerace #satisfying",
    extraTags: ["flags of the world", "flags", "countries battle", "world flags"],
    codes: C(`us br in au za jp eg mx ca gb de fr it es ru cn kr id sa tr
              ar ng ke th vn ph pk ua gr pt se no fi dk nl be ch at pl co`),
  },
];

const BASE_TAGS = [
  "spinning top battle", "marble race", "country battle", "last one standing",
  "tournament", "satisfying", "physics simulation", "beyblade battle",
  "flag battle", "elimination", "who will win",
];

function buildEpisode(theme) {
  const { slug, codes, titleLines, noun, title, hashtags, extraTags } = theme;
  const items = codes.map((c) => ({
    title: NAMES[c],
    value: 1,
    country: c.toUpperCase(),
    imagePath: `flags/${c}.png`,
  }));
  const feature = items.slice(0, 4).map((i) => i.title).join(", ");
  const description = [
    `40 ${noun} enter the arena as spinning tops. They clash, knock each other's spin out, and fall one by one — the LAST top still spinning is the champion. Who will it be? 🏆`,
    ``,
    `Featuring ${feature} and 36 more, battling across 4 groups and a grand final.`,
    ``,
    `👇 Comment which one you're rooting for!`,
    ``,
    `Chapters:`,
    `{{chapters}}`,
    ``,
    hashtags,
  ].join("\n");
  return {
    slug,
    template: "tournament",
    title: titleLines,
    outro: ["", ""],
    unitLabel: "",
    coverFit: "cover",
    compositeFlagOnCover: false,
    audioPath: "audio/Level - The Grey Room _ Density & Time.mp3",
    audioVolume: 0.1,
    tournamentGroupSize: 10,
    items,
    youtube: {
      title: title.slice(0, 100),
      description,
      tags: [...BASE_TAGS, ...extraTags, ...items.slice(0, 12).map((i) => i.title)],
      categoryId: "24",
      privacyStatus: "private",
      madeForKids: false,
      defaultLanguage: "en",
    },
  };
}

// ── Validate ─────────────────────────────────────────────────────────
let problems = 0;
const allSlugs = [];
for (const theme of THEMES) {
  allSlugs.push(theme.slug);
  const { slug, codes } = theme;
  if (codes.length !== 40) {
    console.error(`✗ ${slug}: ${codes.length} codes (need exactly 40)`);
    problems++;
  }
  const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
  if (dupes.length) {
    console.error(`✗ ${slug}: duplicate codes ${[...new Set(dupes)].join(", ")}`);
    problems++;
  }
  for (const c of codes) {
    if (!NAMES[c]) {
      console.error(`✗ ${slug}: no name for code "${c}"`);
      problems++;
    }
    if (!existsSync(path.join(FLAGS_DIR, `${c}.png`))) {
      console.error(`✗ ${slug}: missing flag file flags/${c}.png`);
      problems++;
    }
  }
}

if (problems > 0) {
  console.error(`\n${problems} problem(s) found — nothing written.`);
  process.exit(1);
}
console.log(`✓ All ${THEMES.length} themes valid: 40 unique codes each, every flag present.`);

if (checkOnly) {
  console.log(`\nSlugs:\n  ${allSlugs.join(" ")}`);
  process.exit(0);
}

// ── Write ────────────────────────────────────────────────────────────
await fs.mkdir(EPISODES_DIR, { recursive: true });
for (const theme of THEMES) {
  const ep = buildEpisode(theme);
  const file = path.join(EPISODES_DIR, `${theme.slug}.json`);
  await fs.writeFile(file, JSON.stringify(ep, null, 2) + "\n");
  console.log(`wrote episodes/${theme.slug}.json  (${ep.items.length} countries)`);
}
console.log(`\nNext:`);
console.log(`  for s in ${allSlugs.join(" ")}; do node scripts/tournament-roll.mjs $s --seed=<n>; done`);
console.log(`  node scripts/schedule-batch.mjs --start=<ISO-UTC> --every=3 ${allSlugs.join(" ")}`);
