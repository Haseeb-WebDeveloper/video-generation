#!/usr/bin/env node
// Headless single-battle simulator. Spinning-top elimination — last top
// spinning wins. The simulation core lives in scripts/lib/battle-sim.mjs
// (shared with tournament-roll.mjs); this script handles CLI, dramatic-seed
// selection, and persisting the bake + battleResult into the episode JSON.
//
// Output: public/battle-bakes/<slug>.bin (per-frame transforms, 8 floats/top:
//   x,y,z,qx,qy,qz,qw,energy) + a battleResult patch into episodes/<slug>.json.
//
// Usage:
//   node scripts/battle-roll.mjs <slug>                 # random seed
//   node scripts/battle-roll.mjs <slug> --seed=12345    # specific seed
//   node scripts/battle-roll.mjs <slug> --keep          # reuse stored seed
//   node scripts/battle-roll.mjs <slug> --candidates=8  # try N seeds, lock best

import fs from "node:fs/promises";
import path from "node:path";
import { loadEpisode, writeEpisode } from "./lib/episode-loader.mjs";
import { initRapier, simulateBattle, FPS } from "./lib/battle-sim.mjs";

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith("--"));
if (!slug) {
  console.error(
    "Usage: node scripts/battle-roll.mjs <slug> [--seed=N] [--keep] [--candidates=N]",
  );
  process.exit(1);
}
const seedArg = args.find((a) => a.startsWith("--seed="));
const keepSeed = args.includes("--keep");
const candidatesArg = args.find((a) => a.startsWith("--candidates="));
const numCandidates = candidatesArg ? Number(candidatesArg.split("=")[1]) : 1;
// Optional: force a specific country to win (e.g. --winner=PK). The physics
// stays 100% real — we just search seeds until that country happens to win,
// then lock the most dramatic of those. Ignored when --keep (the stored seed
// already encodes the chosen outcome).
const winnerArg = args.find((a) => a.startsWith("--winner="));
const targetWinner = winnerArg ? winnerArg.split("=")[1].toUpperCase() : null;

await initRapier();

const { episode, paths } = await loadEpisode(slug);
const items = episode.items;
if (!items || items.length < 2) {
  console.error(`Episode "${slug}" has fewer than 2 items — nothing to battle.`);
  process.exit(1);
}
if (targetWinner && !keepSeed && !items.some((it) => (it.country ?? "").toUpperCase() === targetWinner)) {
  console.error(
    `--winner=${targetWinner} is not in this episode's countries: ` +
      items.map((it) => it.country).join(", "),
  );
  process.exit(1);
}

let seedToUse;
if (keepSeed) {
  if (typeof episode.battleSeed !== "number") {
    console.error(`--keep requires battleSeed already set on the episode.`);
    process.exit(1);
  }
  seedToUse = episode.battleSeed;
} else if (seedArg) {
  seedToUse = Number(seedArg.split("=")[1]);
} else {
  seedToUse = Math.floor(Math.random() * 2 ** 31);
}

let best = null;

if (targetWinner && !keepSeed) {
  // Search seeds until the target country wins; collect a handful of matches
  // and lock the most dramatic. (Physics is unchanged — we only pick a seed.)
  const MAX_SEARCH = 1500;
  const MAX_MATCHES = 8;
  let matches = 0;
  for (let i = 0; i < MAX_SEARCH && matches < MAX_MATCHES; i++) {
    const seed = (seedToUse + i) >>> 0;
    const result = simulateBattle({ count: items.length, seed });
    const winnerIdx = result.survivorOrder[0];
    if ((items[winnerIdx].country ?? "").toUpperCase() !== targetWinner) continue;
    matches++;
    const drama = scoreDrama(result);
    if (best == null || drama > best.drama) best = { seed, result, drama };
  }
  if (!best) {
    console.error(`No seed found where ${targetWinner} wins within ${MAX_SEARCH} tries.`);
    process.exit(1);
  }
  console.log(
    `Found ${matches} seed(s) where ${targetWinner} wins — locking the most dramatic.`,
  );
} else {
  const seedsToTry =
    numCandidates > 1
      ? Array.from({ length: numCandidates }, (_, i) =>
          i === 0 ? seedToUse : Math.floor(Math.random() * 2 ** 31),
        )
      : [seedToUse];
  for (const seed of seedsToTry) {
    const result = simulateBattle({ count: items.length, seed });
    const drama = scoreDrama(result);
    const winnerIdx = result.survivorOrder[0];
    console.log(
      `seed ${seed}: ${result.battleFrames}f (${(result.battleFrames / FPS).toFixed(1)}s) ` +
        `winner=items[${winnerIdx}]:${items[winnerIdx].title} drama=${drama.toFixed(2)}`,
    );
    if (best == null || drama > best.drama) best = { seed, result, drama };
  }
}

const chosen = best;
console.log(`\nLocking seed ${chosen.seed} (drama ${chosen.drama.toFixed(2)})`);

const bakesDir = path.join(paths.root, "public", "battle-bakes");
await fs.mkdir(bakesDir, { recursive: true });
const bakeFile = path.join(bakesDir, `${slug}.bin`);
await fs.writeFile(bakeFile, Buffer.from(chosen.result.bake.buffer));

const patched = {
  ...episode,
  battleSeed: chosen.seed,
  battleBakePath: `battle-bakes/${slug}.bin`,
  battleResult: {
    survivorOrder: chosen.result.survivorOrder,
    eliminationFrames: chosen.result.eliminationFrames,
    eliminationReasons: chosen.result.eliminationReasons,
    battleFrames: chosen.result.battleFrames,
  },
};
await writeEpisode(slug, patched);

console.log(
  `\nWinner: items[${chosen.result.survivorOrder[0]}] = ${items[chosen.result.survivorOrder[0]].title}`,
);
console.log(`Wrote bake → ${path.relative(paths.root, bakeFile)}`);

// ── Drama scoring ── duration sweet-spot + elimination spread + final duel.
function scoreDrama({ survivorOrder, eliminationFrames, battleFrames }) {
  const seconds = battleFrames / FPS;
  let s = 0;
  s += 1 - Math.min(1, Math.abs(seconds - 28) / 12);
  const ef = eliminationFrames.filter((f, i) => i !== survivorOrder[0] && f > 0);
  if (ef.length > 1) {
    const mean = ef.reduce((a, b) => a + b, 0) / ef.length;
    const varr = ef.reduce((a, b) => a + (b - mean) ** 2, 0) / ef.length;
    s += Math.min(1.5, Math.sqrt(varr) / (battleFrames * 0.2));
  }
  if (ef.length >= 1) {
    const sorted = ef.slice().sort((a, b) => a - b);
    const lastElim = sorted[sorted.length - 1];
    const penultimate = sorted.length >= 2 ? sorted[sorted.length - 2] : 0;
    s += Math.min(1.5, (lastElim - penultimate) / (FPS * 3));
  }
  return s;
}
