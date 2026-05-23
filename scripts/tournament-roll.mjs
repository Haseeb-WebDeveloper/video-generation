#!/usr/bin/env node
// Bracket baker. Splits items[] into N groups, battles each group, then battles
// the group winners in a final. Writes one bake per round + a tournamentResult
// patch into the episode JSON. Deterministic from a single base seed.
//
// Usage:
//   node scripts/tournament-roll.mjs <slug>              # random base seed
//   node scripts/tournament-roll.mjs <slug> --seed=123   # fixed seed
//   node scripts/tournament-roll.mjs <slug> --keep       # reuse stored seed

import fs from "node:fs/promises";
import path from "node:path";
import { loadEpisode, writeEpisode } from "./lib/episode-loader.mjs";
import { initRapier, simulateBattle, FPS } from "./lib/battle-sim.mjs";

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith("--"));
if (!slug) {
  console.error("Usage: node scripts/tournament-roll.mjs <slug> [--seed=N] [--keep]");
  process.exit(1);
}
const seedArg = args.find((a) => a.startsWith("--seed="));
const keepSeed = args.includes("--keep");

await initRapier();

const { episode, paths } = await loadEpisode(slug);
const items = episode.items;
const groupSize = episode.tournamentGroupSize ?? 10;
if (!items || items.length < groupSize * 2) {
  console.error(`Tournament needs at least ${groupSize * 2} items (got ${items?.length ?? 0}).`);
  process.exit(1);
}
const numGroups = Math.floor(items.length / groupSize);

let baseSeed;
if (keepSeed && typeof episode.tournamentSeed === "number") baseSeed = episode.tournamentSeed;
else if (seedArg) baseSeed = Number(seedArg.split("=")[1]);
else baseSeed = Math.floor(Math.random() * 2 ** 31);

const bakesDir = path.join(paths.root, "public", "battle-bakes");
await fs.mkdir(bakesDir, { recursive: true });

const rounds = [];

async function runRound(kind, label, itemIndices, seed, roundFileIdx) {
  const res = simulateBattle({ count: itemIndices.length, seed });
  const bakeRel = `battle-bakes/${slug}-r${roundFileIdx}.bin`;
  await fs.writeFile(path.join(paths.root, "public", bakeRel), Buffer.from(res.bake.buffer));
  const winnerLocal = res.survivorOrder[0];
  const winnerIndex = itemIndices[winnerLocal];
  rounds.push({
    kind,
    label,
    itemIndices,
    bakePath: bakeRel,
    survivorOrder: res.survivorOrder,
    eliminationFrames: res.eliminationFrames,
    battleFrames: res.battleFrames,
    winnerIndex,
    collisions: res.collisions,
  });
  console.log(
    `${label}: ${itemIndices.length} tops, ${res.battleFrames}f (${(res.battleFrames / FPS).toFixed(1)}s) ` +
      `→ winner items[${winnerIndex}] = ${items[winnerIndex].title}`,
  );
  return winnerIndex;
}

console.log(`Tournament "${slug}": ${numGroups} groups of ${groupSize}, base seed ${baseSeed}\n`);

// Group rounds
for (let g = 0; g < numGroups; g++) {
  const itemIndices = Array.from({ length: groupSize }, (_, k) => g * groupSize + k);
  await runRound("group", `ROUND ${g + 1}`, itemIndices, baseSeed + g * 1000 + 1, g);
}

// Final from the group winners
const finalIndices = rounds.map((r) => r.winnerIndex);
const championIndex = await runRound("final", "FINAL", finalIndices, baseSeed + 99000, numGroups);

const patched = {
  ...episode,
  tournamentSeed: baseSeed,
  tournamentResult: { rounds, championIndex },
};
// Auto-generate YouTube SEO metadata if the episode doesn't already have a
// hand-authored `youtube` block (never reveals the winner — no spoilers).
if (!patched.youtube || !patched.youtube.title) {
  patched.youtube = { ...(patched.youtube ?? {}), ...generateYoutubeMeta(items) };
  console.log("Generated youtube metadata block (title/description/tags).");
}
await writeEpisode(slug, patched);

function generateYoutubeMeta(items) {
  const names = items.map((it) => it.title);
  const n = names.length;
  const feature = names.slice(0, 4).join(", ");
  const title = `Spinning Top Battle 🌍 ${n} Countries — Last One Spinning Wins!`;
  const description = [
    `${n} countries enter the arena as spinning tops. They clash, knock each other's spin out, and fall one by one. The LAST top still spinning is the champion. Who will it be? 🏆`,
    ``,
    `Featuring ${feature} and ${n - 4} more nations battling across ${
      patched.tournamentResult.rounds.length - 1
    } groups and a grand final.`,
    ``,
    `👇 Comment which country you're rooting for!`,
    ``,
    `Chapters:`,
    `{{chapters}}`,
    ``,
    `#spinningtop #marblerace #countrybattle #satisfying`,
  ].join("\n");
  const tags = [
    "spinning top battle",
    "marble race",
    "country battle",
    "countries battle",
    "last one standing",
    "tournament",
    "satisfying",
    "physics simulation",
    "beyblade battle",
    "flag battle",
    "elimination",
    "who will win",
    ...names.slice(0, 12),
  ];
  return {
    title: title.slice(0, 100),
    description,
    tags,
    categoryId: "24",
    privacyStatus: "private",
    madeForKids: false,
    defaultLanguage: "en",
  };
}

console.log(
  `\n🏆 CHAMPION: items[${championIndex}] = ${items[championIndex].title}` +
    `  (base seed ${baseSeed})`,
);
console.log(`Patched episode JSON: ${path.relative(paths.root, paths.episodeFile)}`);
