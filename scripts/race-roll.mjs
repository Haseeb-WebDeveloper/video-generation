#!/usr/bin/env node
// Headless race simulator. Runs Rapier3D against a procedurally-generated
// peg-field track, writes per-frame ball transforms to public/race-bakes/
// <slug>.bin, and patches raceSeed + raceResult + raceBakePath into the
// episode JSON.
//
// Determinism note: Rapier is deterministic given identical inputs (same
// seed, same collider order, same step count). We rebuild the world fresh
// for every roll and never read external clocks, so the bake byte-for-byte
// reproduces the recorded raceResult.
//
// Coordinate system: gravity is tilted in +X so "downhill" is just +X
// along a FLAT floor at y=0. This sidesteps the math of rotated colliders —
// pegs stand straight up, side walls are vertical, and the kill plane is
// just `y < -5`. The track is therefore a 200-unit long alley with a peg
// field, contained side walls, and a finish trigger at x=FINISH_X.
//
// Usage:
//   node scripts/race-roll.mjs <slug>                 # random seed
//   node scripts/race-roll.mjs <slug> --seed=12345    # specific seed
//   node scripts/race-roll.mjs <slug> --keep          # reuse existing seed
//   node scripts/race-roll.mjs <slug> --candidates=8  # try N seeds, print
//                                                       a drama summary,
//                                                       lock the BEST.

import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import RAPIER from "@dimforge/rapier3d-compat";
import { loadEpisode, writeEpisode } from "./lib/episode-loader.mjs";

// ───── Track constants (match values consumed by src/race-slides.tsx) ─────
// Any change here invalidates existing bakes; bump RACE_TRACK_VERSION too.
export const RACE_TRACK_VERSION = 1;

// World gravity: tilted so +X is downhill. TRACK_TILT_DEG = 22 gives an
// effective downslope acceleration of g*sin(22°) ≈ 3.67 m/s², which after
// peg drag produces a ~18-22-second race over a 140-unit alley. Steeper =
// faster = less time for drama; shallower = the back of the pack lags too
// long and viewers drop. 14° tested too slow (hit the 50s cap).
const TRACK_TILT_DEG = 30;
const GRAVITY_MAG = 9.81;

const TRACK_LEN = 110; // x in [0, TRACK_LEN]
const TRACK_HALF_Z = 12; // z in [-TRACK_HALF_Z, +TRACK_HALF_Z]
const FLOOR_Y = 0;
const WALL_HEIGHT = 4;
const FINISH_X = TRACK_LEN - 5; // x value that counts as crossing the line
const KILL_Y = -5; // y below this = ball is gone (eliminated)

const BALL_R = 0.7;
const PEG_R = 0.45;
const PEG_H = 2.0;

// Race timing.
const FPS = 60;
const MAX_RACE_SECONDS = 35; // safety cap; balls that haven't finished by now
//                              are recorded as eliminations at MAX.
const MAX_FRAMES = MAX_RACE_SECONDS * FPS;

// ───── CLI parsing ─────
const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith("--"));
if (!slug) {
  console.error(
    "Usage: node scripts/race-roll.mjs <slug> [--seed=N] [--keep] [--candidates=N]",
  );
  process.exit(1);
}
const seedArg = args.find((a) => a.startsWith("--seed="));
const keepSeed = args.includes("--keep");
const candidatesArg = args.find((a) => a.startsWith("--candidates="));
const numCandidates = candidatesArg ? Number(candidatesArg.split("=")[1]) : 1;

// ───── Main ─────
await RAPIER.init();

const { episode, paths } = await loadEpisode(slug);
const items = episode.items;
if (!items || items.length < 2) {
  console.error(`Episode "${slug}" has fewer than 2 items — nothing to race.`);
  process.exit(1);
}
if (items.length > 32) {
  console.error(
    `Race template caps at 32 participants (got ${items.length}). ` +
      `Trim items[] or bump the cap.`,
  );
  process.exit(1);
}

let seedToUse;
if (keepSeed) {
  if (typeof episode.raceSeed !== "number") {
    console.error(`--keep requires raceSeed already set on the episode.`);
    process.exit(1);
  }
  seedToUse = episode.raceSeed;
} else if (seedArg) {
  seedToUse = Number(seedArg.split("=")[1]);
} else {
  seedToUse = Math.floor(Math.random() * 2 ** 31);
}

let best = null;
const seedsToTry =
  numCandidates > 1
    ? Array.from({ length: numCandidates }, (_, i) =>
        i === 0 ? seedToUse : Math.floor(Math.random() * 2 ** 31),
      )
    : [seedToUse];

for (const seed of seedsToTry) {
  const result = simulateRace({ items, seed });
  const drama = scoreDrama(result);
  console.log(
    `seed ${seed}: ${result.raceFrames}f (${(result.raceFrames / FPS).toFixed(1)}s) ` +
      `finished=${result.finishOrder.length}/${items.length} ` +
      `eliminated=${result.eliminations.length} drama=${drama.toFixed(2)}`,
  );
  if (best == null || drama > best.drama) best = { seed, result, drama };
}

const chosen = best;
console.log(
  `\nLocking seed ${chosen.seed} (drama ${chosen.drama.toFixed(2)})`,
);
console.log(
  "Finish order (item index → title):\n" +
    chosen.result.finishOrder
      .slice(0, 5)
      .map(
        (idx, place) =>
          `  #${place + 1}: items[${idx}] = ${items[idx].title}`,
      )
      .join("\n"),
);

// ───── Persist bake + JSON patch ─────
const bakesDir = path.join(paths.root, "public", "race-bakes");
await fs.mkdir(bakesDir, { recursive: true });
const bakeFile = path.join(bakesDir, `${slug}.bin`);
await fs.writeFile(bakeFile, Buffer.from(chosen.result.bake.buffer));

const patched = {
  ...episode,
  raceSeed: chosen.seed,
  raceBakePath: `race-bakes/${slug}.bin`,
  raceResult: {
    finishOrder: chosen.result.finishOrder,
    finishFrames: chosen.result.finishFrames,
    eliminations: chosen.result.eliminations,
    raceFrames: chosen.result.raceFrames,
  },
};
await writeEpisode(slug, patched);

console.log(
  `\nWrote bake (${(chosen.result.bake.byteLength / 1024).toFixed(0)} KB) → ` +
    path.relative(paths.root, bakeFile),
);
console.log(`Patched episode JSON: ${path.relative(paths.root, paths.episodeFile)}`);

// ───── Simulation core ─────
function simulateRace({ items, seed }) {
  const N = items.length;
  const rand = mulberry32(seed);

  const tiltRad = (TRACK_TILT_DEG * Math.PI) / 180;
  const world = new RAPIER.World({
    x: Math.sin(tiltRad) * GRAVITY_MAG,
    y: -Math.cos(tiltRad) * GRAVITY_MAG,
    z: 0,
  });

  buildTrack({ world, rand });
  const balls = spawnGrid({ world, count: N, rand });

  const bake = new Float32Array(MAX_FRAMES * N * 7);
  const finishOrder = [];
  const finishFrames = [];
  const eliminations = [];
  const finished = new Set();
  const eliminated = new Set();

  let frame = 0;
  for (; frame < MAX_FRAMES; frame++) {
    world.step();

    for (let i = 0; i < N; i++) {
      const body = balls[i];
      const t = body.translation();
      const r = body.rotation();
      const off = (frame * N + i) * 7;
      bake[off + 0] = t.x;
      bake[off + 1] = t.y;
      bake[off + 2] = t.z;
      bake[off + 3] = r.x;
      bake[off + 4] = r.y;
      bake[off + 5] = r.z;
      bake[off + 6] = r.w;

      if (finished.has(i) || eliminated.has(i)) continue;

      if (t.y < KILL_Y) {
        eliminated.add(i);
        eliminations.push({ index: i, frame });
        // Park the eliminated body well below the kill plane so its baked
        // transforms stop polluting the camera view (it would otherwise
        // fall forever, ballooning bake size and risking auto-frame fits).
        body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
        body.setTranslation({ x: t.x, y: -50, z: t.z }, true);
      } else if (t.x > FINISH_X) {
        finished.add(i);
        finishOrder.push(i);
        finishFrames.push(frame);
        // Important: do NOT setBodyType(Fixed) here. A finished ball that
        // freezes in place becomes an immovable collider — following balls
        // hit it and ricochet back uphill, producing fake non-finishes.
        // Instead let it roll on naturally and collect against the
        // backstop; we just stop processing finish/kill events for it.
      }
    }

    if (finished.size + eliminated.size === N) {
      // One full frame of grace so the closing transforms get recorded.
      frame++;
      break;
    }
  }

  // Anyone left racing at MAX_FRAMES counts as eliminated at the cap so the
  // template doesn't have to special-case "never finished, never died."
  for (let i = 0; i < N; i++) {
    if (!finished.has(i) && !eliminated.has(i)) {
      eliminations.push({ index: i, frame: frame - 1 });
    }
  }

  const raceFrames = frame;
  const trimmed = new Float32Array(
    bake.buffer,
    0,
    raceFrames * N * 7,
  ).slice(); // .slice() detaches from the oversize buffer

  return {
    bake: trimmed,
    finishOrder,
    finishFrames,
    eliminations,
    raceFrames,
  };
}

// ───── World construction ─────
function buildTrack({ world, rand }) {
  // Floor.
  const floor = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(TRACK_LEN / 2, FLOOR_Y - 0.5, 0),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(TRACK_LEN / 2, 0.5, TRACK_HALF_Z)
      .setFriction(0.4)
      .setRestitution(0.25),
    floor,
  );

  // Side walls (+Z and -Z).
  for (const zSign of [-1, 1]) {
    const wall = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(
        TRACK_LEN / 2,
        FLOOR_Y + WALL_HEIGHT / 2,
        zSign * (TRACK_HALF_Z + 0.5),
      ),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(TRACK_LEN / 2, WALL_HEIGHT / 2, 0.5)
        .setFriction(0.3)
        .setRestitution(0.2),
      wall,
    );
  }

  // Back wall (start gate) at x = -1, so balls placed at x ∈ [0, 6] can't
  // roll uphill out of bounds during the initial settle.
  const back = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(-1, FLOOR_Y + WALL_HEIGHT / 2, 0),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.5, WALL_HEIGHT / 2, TRACK_HALF_Z)
      .setFriction(0.2)
      .setRestitution(0.4),
    back,
  );

  // Finish backstop just beyond FINISH_X so balls actually collect there
  // visually rather than rolling off the edge of the world after crossing.
  const front = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(
      TRACK_LEN + 0.5,
      FLOOR_Y + WALL_HEIGHT / 2,
      0,
    ),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.5, WALL_HEIGHT / 2, TRACK_HALF_Z)
      .setFriction(0.3)
      .setRestitution(0.15),
    front,
  );

  // Peg field. Pegs are vertical cylinders standing up out of the floor.
  // They live mostly in the middle 60% of the track so the start and
  // finish stretches stay clean.
  const PEG_X_MIN = 15;
  const PEG_X_MAX = TRACK_LEN - 18;
  const PEG_ROW_DX = 9;
  const PEG_ROW_DZ = 6;
  const numRows = Math.floor((PEG_X_MAX - PEG_X_MIN) / PEG_ROW_DX);
  for (let row = 0; row < numRows; row++) {
    const x = PEG_X_MIN + row * PEG_ROW_DX;
    const offset = row % 2 === 0 ? 0 : PEG_ROW_DZ / 2;
    const zJitter = (rand() - 0.5) * 1.5;
    for (let z = -TRACK_HALF_Z + 3; z <= TRACK_HALF_Z - 3; z += PEG_ROW_DZ) {
      // ~60% of grid cells get a peg; the gaps make the chaos uneven
      // and stop balls from getting permanently wedged into a peg row.
      if (rand() > 0.6) continue;
      const peg = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(
          x + (rand() - 0.5) * 1.2,
          FLOOR_Y + PEG_H / 2,
          z + offset + zJitter,
        ),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cylinder(PEG_H / 2, PEG_R)
          .setFriction(0.2)
          .setRestitution(0.6),
        peg,
      );
    }
  }
}

function spawnGrid({ world, count, rand }) {
  const balls = [];
  const ROW_COUNT = Math.ceil(count / 5);
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 5);
    const col = i % 5;
    const x = 2 + row * 2.2;
    const z = -10 + col * 5 + (rand() - 0.5) * 0.4;
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, FLOOR_Y + BALL_R + 0.5 + row * 0.1, z)
        // Small lateral jitter velocity so identical seeds across runs
        // produce identical races but the field doesn't move as a column.
        .setLinvel((rand() - 0.5) * 0.3, 0, (rand() - 0.5) * 0.3)
        .setLinearDamping(0.05)
        .setAngularDamping(0.1)
        .setCcdEnabled(true),
    );
    world.createCollider(
      RAPIER.ColliderDesc.ball(BALL_R)
        .setDensity(1.0 + (rand() - 0.5) * 0.1)
        .setFriction(0.3)
        .setRestitution(0.55),
      body,
    );
    balls.push(body);
    void ROW_COUNT;
  }
  return balls;
}

// ───── Drama scoring ─────
// Rank a race candidate so --candidates can pick the most-watchable seed.
// The signal we want, in priority order:
//   1. All N balls eventually account for themselves (finish or out).
//   2. The race doesn't end too quickly (sub-10s) or drag past 30s.
//   3. The photo finish: gap between #1 and #2 is small relative to the
//      gap between #1 and #5. A close fight at the front is the moment
//      we cut to slow-mo.
//   4. Eliminations are spread out, not all bunched at the start.
function scoreDrama({ finishOrder, finishFrames, eliminations, raceFrames }) {
  if (finishOrder.length < 3) return 0;
  const seconds = raceFrames / FPS;
  let s = 0;
  // Sweet spot duration: ~18-26s.
  s += 1 - Math.min(1, Math.abs(seconds - 22) / 15);

  // Photo finish: smaller gap to #2 = more dramatic.
  const dt12 = (finishFrames[1] - finishFrames[0]) / FPS;
  s += Math.max(0, 1 - dt12 / 3);

  // Field spread: time between #1 and #5 should be at least 3s so the
  // back of the field has its own arc.
  if (finishFrames.length >= 5) {
    const dt15 = (finishFrames[4] - finishFrames[0]) / FPS;
    s += Math.min(1, dt15 / 6);
  }

  // Eliminations: a few spread across the race is good; all at frame 0
  // or none at all is boring.
  if (eliminations.length > 0) {
    const elimFrames = eliminations.map((e) => e.frame);
    const spread =
      (Math.max(...elimFrames) - Math.min(...elimFrames)) / Math.max(1, raceFrames);
    s += spread * 0.5;
  }

  return s;
}

// ───── Utility ─────
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
