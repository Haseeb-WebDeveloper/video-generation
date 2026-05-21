#!/usr/bin/env node
// Headless spinning-top battle simulator. Beyblade-style elimination —
// every top starts with the same vertical angular velocity in a circular
// wooden arena. As angular damping bleeds spin and top-top collisions
// transfer momentum, tops either slow below a stopping threshold or get
// knocked over the arena rim. Last top still spinning wins.
//
// Output: public/battle-bakes/<slug>.bin (per-frame transforms) + a
// battleResult patch into episodes/<slug>.json describing seed, survivor
// order, and per-top elimination frame/reason.
//
// Determinism note: Rapier is deterministic given identical inputs (same
// seed, same collider order, same step count). Fresh world per roll; no
// external clocks. The bake byte-for-byte reproduces battleResult.
//
// Bake layout: Float32Array, 8 floats per top per frame:
//   [x, y, z, qx, qy, qz, qw, energy]
// where energy = clamp(|angvel.y| / INIT_SPIN, 0, 1). Stored each frame
// so the renderer can drive wobble + leaderboard bars without having to
// re-derive angular velocity from quaternion deltas. (Race's bake is
// 7 floats — top-battle is 8. Different reader code accordingly.)
//
// Usage:
//   node scripts/battle-roll.mjs <slug>                 # random seed
//   node scripts/battle-roll.mjs <slug> --seed=12345    # specific seed
//   node scripts/battle-roll.mjs <slug> --keep          # reuse existing seed
//   node scripts/battle-roll.mjs <slug> --candidates=8  # try N seeds, lock
//                                                         the most-dramatic.

import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import RAPIER from "@dimforge/rapier3d-compat";
import { loadEpisode, writeEpisode } from "./lib/episode-loader.mjs";

// ───── Arena constants (match values consumed by src/top-battle-slides.tsx) ─────
// Any change here invalidates existing bakes; bump BATTLE_ARENA_VERSION too.
export const BATTLE_ARENA_VERSION = 1;

const FLOOR_Y = 0;
// Rectangular steel arena (16:9 aspect to match the video frame). Tops
// spawn in the middle, collide once, then freeze in place. The wall
// rectangle is a touch larger than the visible inner play area so the
// outer beveled steel frame in the renderer sits flush with the wall
// collider edges.
const ARENA_HALF_X = 10.0;       // arena spans x ∈ [-10, +10]
const ARENA_HALF_Z = 5.625;      // arena spans z ∈ [-5.625, +5.625] (16:9)
const WALL_THICKNESS = 0.6;
const WALL_HEIGHT = 1.6;
const KILL_Y = -4;               // safety net only

const TOP_RADIUS = 0.85;
const TOP_HEIGHT = 1.0;
const SPAWN_RADIUS = 2.5;        // wider so post-collision separation is
//                                 ~2 top diameters and they don't end up
//                                 visually overlapping when at rest
const SPAWN_Y = TOP_HEIGHT / 2 + 0.25;

// Settle behavior — modeled on how Unity / Unreal handle resting bodies
// instead of the previous hard frame-90 freeze (which snapped tops
// instantly and looked artificial).
//
//   1. Strip horizontal angvel components (X, Z) every frame so tops
//      ONLY rotate around their vertical axis. Tipping is purely a
//      visual death-wobble in the renderer, never a physics effect.
//   2. Sleep-threshold dead-zone: once a top's lateral speed drops
//      below SLEEP_LINVEL_THRESHOLD it's snapped to zero for that
//      frame. Above that, physics damping handles the smooth decay.
//   3. High LINEAR_DAMPING brings translation below the threshold
//      within ~1.5 s of the collision via natural exponential decay,
//      so the snap-to-zero is imperceptible when it kicks in.
//
// Net effect: launch → impact → smooth decel → rest, identical curve
// to a real rigid-body game engine's resting behavior.
const SLEEP_LINVEL_THRESHOLD = 0.015;

// New behavior model — per user request, the battle is a single "smash
// then settle" plus a pure spin-decay race:
//   1. At GO, every top is flung at its neighbors with a strong impulse.
//   2. Tops collide once (sometimes twice with quick caroms) over the
//      first ~1.5 s.
//   3. High linear damping aggressively kills translational velocity, so
//      from ~2 s onward tops sit still and ONLY spin around their Y axis.
//   4. From there it's pure spin-decay — whoever still has angvel above
//      STOP_THRESHOLD last wins. No second collisions, no knockouts.
const INIT_SPIN = 60;            // rad/s around y at battle start
const SPIN_JITTER = 18;          // wide spin variance so deaths spread
//                                 across several seconds, not lock-step
const STOP_THRESHOLD = 4;
const STOP_DWELL_FRAMES = 20;

// DYNAMIC MODEL (walled arena + spin-decay): tops keep bouncing off the
// walls and each other for the whole battle instead of freezing after one
// smash. Low linear damping + lively restitution sustains the motion;
// spin decays (angular damping + floor friction) and whoever spins longest
// wins. Eliminations are by spin only — bouncing is the visual drama.
const ANGULAR_DAMPING = 0.010;   // very low — spin needs to last
const ANGULAR_DAMPING_JITTER = 0.020; // per-top jitter for varied lifespan
const LINEAR_DAMPING = 0.22;     // LOW so tops keep gliding/colliding; bounce
//                                 energy bleeds mainly via restitution losses
const TOP_FRICTION = 0.02;       // floor-friction torque drains Y-spin
//                                 — tuned for ~25-40 s healthy spin life

// Continuous "stir": every NUDGE_INTERVAL frames each still-alive top gets a
// small random horizontal velocity nudge scaled by its current spin energy.
// This is what keeps the battle dynamic — spinning tops perpetually drift and
// re-collide instead of jamming at the center and freezing (mirrors a real
// spinning top's restless wandering / the Blender turbulence approach). As a
// top loses spin it also moves less, so it naturally calms before it stops.
const NUDGE_INTERVAL = 18;       // frames between nudges (~0.3s @ 60fps)
const NUDGE_STRENGTH = 3.2;      // m/s peak at full energy
const TOP_RESTITUTION = 0.82;    // lively top-top caroms
const FLOOR_FRICTION = 0.10;
const FLOOR_RESTITUTION = 0.05;  // floor barely bounces — no vertical hop
const WALL_FRICTION = 0.10;
const WALL_RESTITUTION = 0.78;   // walls keep the tops in play, bouncing back

// Timing.
const FPS = 60;
const MAX_BATTLE_SECONDS = 70;
const MAX_FRAMES = MAX_BATTLE_SECONDS * FPS;

// ───── CLI parsing ─────
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

// ───── Main ─────
await RAPIER.init();

const { episode, paths } = await loadEpisode(slug);
const items = episode.items;
if (!items || items.length < 2) {
  console.error(`Episode "${slug}" has fewer than 2 items — nothing to battle.`);
  process.exit(1);
}
if (items.length > 32) {
  console.error(
    `Top-battle template caps at 32 participants (got ${items.length}). ` +
      `Trim items[] or bump the cap.`,
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
const seedsToTry =
  numCandidates > 1
    ? Array.from({ length: numCandidates }, (_, i) =>
        i === 0 ? seedToUse : Math.floor(Math.random() * 2 ** 31),
      )
    : [seedToUse];

for (const seed of seedsToTry) {
  const result = simulateBattle({ items, seed });
  const drama = scoreDrama(result);
  const winnerIdx = result.survivorOrder[0];
  console.log(
    `seed ${seed}: ${result.battleFrames}f (${(result.battleFrames / FPS).toFixed(1)}s) ` +
      `winner=items[${winnerIdx}]:${items[winnerIdx].title} ` +
      `drama=${drama.toFixed(2)}`,
  );
  if (best == null || drama > best.drama) best = { seed, result, drama };
}

const chosen = best;
console.log(
  `\nLocking seed ${chosen.seed} (drama ${chosen.drama.toFixed(2)})`,
);
console.log(
  "Survivor order (top 5):\n" +
    chosen.result.survivorOrder
      .slice(0, 5)
      .map(
        (idx, place) =>
          `  #${place + 1}: items[${idx}] = ${items[idx].title}` +
          (place === 0
            ? " (SURVIVOR)"
            : ` (${chosen.result.eliminationReasons[idx]} @ f${chosen.result.eliminationFrames[idx]})`),
      )
      .join("\n"),
);

// ───── Persist bake + JSON patch ─────
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
  `\nWrote bake (${(chosen.result.bake.byteLength / 1024).toFixed(0)} KB) → ` +
    path.relative(paths.root, bakeFile),
);
console.log(`Patched episode JSON: ${path.relative(paths.root, paths.episodeFile)}`);

// ───── Simulation core ─────
function simulateBattle({ items, seed }) {
  const N = items.length;
  const rand = mulberry32(seed);

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  buildArena({ world });
  const tops = spawnRing({ world, count: N, rand });

  // 8 floats per top per frame: xyz, qx-qw, energy.
  const bake = new Float32Array(MAX_FRAMES * N * 8);
  const eliminationFrames = new Array(N).fill(-1);
  const eliminationReasons = new Array(N).fill(null);
  const eliminated = new Set();
  // Track how many consecutive frames a top has been below the spin
  // threshold — needed for the dwell-based "stopped" detection.
  const slowStreak = new Array(N).fill(0);
  // Order tops were eliminated, so survivorOrder = [winner, ...reverse].
  const elimOrder = [];

  let frame = 0;
  for (; frame < MAX_FRAMES; frame++) {
    world.step();

    // ── Engine-style settle pass, EVERY frame for alive tops ──
    //
    // 1. Strip horizontal angvel: tops only spin around Y. Any X/Z
    //    angular velocity from a glancing collision would tip the
    //    top over physically — we don't want that (visual death-
    //    wobble in the renderer is independent).
    // 2. Vertical linvel: zero out so tops don't keep hopping on
    //    the floor from microscopic restitution bounces.
    // 3. Lateral linvel: if below SLEEP_LINVEL_THRESHOLD, snap to
    //    zero (sleep state). Above the threshold, leave it to the
    //    physics damping which produces smooth exponential decay.
    //    This is the standard pattern used by Unity Rigidbody,
    //    Unreal PhysX, etc.
    const doNudge = frame > 30 && frame % NUDGE_INTERVAL === 0;
    for (let i = 0; i < N; i++) {
      const body = tops[i];
      const lv = body.linvel();
      const av = body.angvel();
      // Keep every top upright (only Y-spin) and on the floor (no hop).
      const vx = lv.x;
      const vz = lv.z;
      if (eliminated.has(i)) {
        // Stopped top: stays in place as a bumpable obstacle. No self-spin,
        // no nudge — but still fully dynamic so live tops collide with it and
        // it reacts (slides, transfers momentum) normally. Never disappears.
        body.setLinvel({ x: vx, y: 0, z: vz }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        continue;
      }
      // Alive top: periodic energy-scaled stir keeps it wandering & colliding.
      let nx = vx;
      let nz = vz;
      if (doNudge) {
        const energy = Math.max(0, Math.min(1, Math.abs(av.y) / INIT_SPIN));
        const ang = rand() * Math.PI * 2;
        const mag = NUDGE_STRENGTH * energy;
        nx += Math.cos(ang) * mag;
        nz += Math.sin(ang) * mag;
      }
      body.setLinvel({ x: nx, y: 0, z: nz }, true);
      body.setAngvel({ x: 0, y: av.y, z: 0 }, true);
    }

    for (let i = 0; i < N; i++) {
      const body = tops[i];
      const t = body.translation();
      const r = body.rotation();
      const av = body.angvel();
      const spinMag = Math.abs(av.y);
      const energy = Math.max(0, Math.min(1, spinMag / INIT_SPIN));

      const off = (frame * N + i) * 8;
      bake[off + 0] = t.x;
      bake[off + 1] = t.y;
      bake[off + 2] = t.z;
      bake[off + 3] = r.x;
      bake[off + 4] = r.y;
      bake[off + 5] = r.z;
      bake[off + 6] = r.w;
      bake[off + 7] = energy;

      if (eliminated.has(i)) continue;

      // Knockouts are no longer expected with the high-damping model
      // (tops freeze in place after the first collision). Kill-plane
      // check stays as a defensive safety net only.
      if (t.y < KILL_Y) {
        killTop(i, frame, "fell", body, t, eliminated, eliminationFrames, eliminationReasons, elimOrder);
        continue;
      }

      // Stopped: sustained low spin.
      if (spinMag < STOP_THRESHOLD) {
        slowStreak[i] += 1;
        if (slowStreak[i] >= STOP_DWELL_FRAMES) {
          killTop(i, frame, "stopped", body, t, eliminated, eliminationFrames, eliminationReasons, elimOrder);
        }
      } else {
        slowStreak[i] = 0;
      }
    }

    // End: one top left = winner.
    if (eliminated.size >= N - 1) {
      // One full frame of grace so the closing transforms get recorded.
      frame++;
      break;
    }
  }

  // The sole survivor (or any never-eliminated at the cap) gets recorded
  // with eliminationFrame = battleFrames and reason = "stopped" by
  // convention, but is NOT pushed to elimOrder — they're the winner.
  for (let i = 0; i < N; i++) {
    if (!eliminated.has(i)) {
      eliminationFrames[i] = frame;
      eliminationReasons[i] = "stopped"; // placeholder; renderer treats
      //                                    survivor specially via survivorOrder[0]
    }
  }

  // survivorOrder: winner first, then most-recently-eliminated, …, first-eliminated last.
  const survivors = [];
  for (let i = 0; i < N; i++) if (!eliminated.has(i)) survivors.push(i);
  const survivorOrder = [...survivors, ...elimOrder.slice().reverse()];

  const battleFrames = frame;
  const trimmed = new Float32Array(
    bake.buffer,
    0,
    battleFrames * N * 8,
  ).slice();

  // Debug: how each top got eliminated. Iterate elimOrder (not the full
  // reasons array) so the survivor's "stopped" placeholder isn't counted.
  const counts = { stopped: 0, knockout: 0, fell: 0 };
  for (const i of elimOrder) counts[eliminationReasons[i]] += 1;
  console.log(
    `  ${survivors.length} survivor(s); eliminations: ` +
      `stopped=${counts.stopped} knockout=${counts.knockout} fell=${counts.fell}`,
  );

  return {
    bake: trimmed,
    survivorOrder,
    eliminationFrames,
    eliminationReasons,
    battleFrames,
  };
}

function killTop(i, frame, reason, body, t, eliminated, eliminationFrames, eliminationReasons, elimOrder) {
  eliminated.add(i);
  eliminationFrames[i] = frame;
  eliminationReasons[i] = reason;
  elimOrder.push(i);
  // Do NOT remove the body — a stopped top stays right where it is and
  // remains a dynamic, collidable obstacle (live tops bump it and it reacts).
  // We just kill its spin; the per-frame settle pass keeps it upright.
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
}

// ───── World construction ─────
function buildArena({ world }) {
  // Flat rectangular steel floor. Top surface at y = FLOOR_Y.
  const floor = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, FLOOR_Y - 0.5, 0),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(ARENA_HALF_X + 2, 0.5, ARENA_HALF_Z + 2)
      .setFriction(FLOOR_FRICTION)
      .setRestitution(FLOOR_RESTITUTION),
    floor,
  );

  // Four rectangular walls — the steel frame around the arena. Walls
  // are thicker than they need to be visually so a fast-moving top
  // can't tunnel through them, and tall enough that even a high bounce
  // is contained.
  const walls = [
    // ±X long walls (top/bottom of the rectangle when viewed from above)
    { cx: 0, cz: ARENA_HALF_Z + WALL_THICKNESS / 2, hx: ARENA_HALF_X + WALL_THICKNESS, hz: WALL_THICKNESS / 2 },
    { cx: 0, cz: -(ARENA_HALF_Z + WALL_THICKNESS / 2), hx: ARENA_HALF_X + WALL_THICKNESS, hz: WALL_THICKNESS / 2 },
    // ±Z short walls (left/right edges of the rectangle)
    { cx: ARENA_HALF_X + WALL_THICKNESS / 2, cz: 0, hx: WALL_THICKNESS / 2, hz: ARENA_HALF_Z },
    { cx: -(ARENA_HALF_X + WALL_THICKNESS / 2), cz: 0, hx: WALL_THICKNESS / 2, hz: ARENA_HALF_Z },
  ];
  for (const w of walls) {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(w.cx, FLOOR_Y + WALL_HEIGHT / 2, w.cz),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(w.hx, WALL_HEIGHT / 2, w.hz)
        .setFriction(WALL_FRICTION)
        .setRestitution(WALL_RESTITUTION),
      body,
    );
  }
}

function spawnRing({ world, count, rand }) {
  const tops = [];
  // Spawn in a tight central ring inside the rectangular arena. Each
  // top is flung straight at the centroid (origin) so all N converge
  // on the same point ~0.5-0.6 s in, producing the single big smash
  // the user wants. After FREEZE_AFTER_FRAME the sim loop manually
  // zeros translation, so they stay exactly where the carom dropped
  // them.
  for (let i = 0; i < count; i++) {
    const theta = (i / count) * Math.PI * 2 + (rand() - 0.5) * 0.12;
    const r = SPAWN_RADIUS + (rand() - 0.5) * 0.2;
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    const spin = INIT_SPIN + (rand() - 0.5) * 2 * SPIN_JITTER;
    const angDamp = ANGULAR_DAMPING + (rand() - 0.5) * 2 * ANGULAR_DAMPING_JITTER;
    // Gentle inward kick: tops converge for a first clash, then the low
    // linear damping + bouncy walls keep them caroming for the whole battle.
    const inward = 3.0 + rand() * 1.8;
    // Blend inward + tangential + random so tops circulate and spread across
    // the arena rather than all converging on the center and jamming.
    const tangSign = rand() < 0.5 ? 1 : -1;
    const inX = -Math.cos(theta), inZ = -Math.sin(theta);
    const tanX = -Math.sin(theta) * tangSign, tanZ = Math.cos(theta) * tangSign;
    const rAng = rand() * Math.PI * 2;
    let dirX = inX * 0.4 + tanX * 0.8 + Math.cos(rAng) * 0.4;
    let dirZ = inZ * 0.4 + tanZ * 0.8 + Math.sin(rAng) * 0.4;
    const dl = Math.hypot(dirX, dirZ) || 1;
    dirX /= dl;
    dirZ /= dl;
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, SPAWN_Y, z)
        .setAngvel({ x: 0, y: spin, z: 0 })
        .setLinvel(dirX * inward, 0, dirZ * inward)
        .setAngularDamping(Math.max(0.005, angDamp))
        .setLinearDamping(LINEAR_DAMPING)
        .setCcdEnabled(true),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cylinder(TOP_HEIGHT / 2, TOP_RADIUS)
        .setDensity(1.0)
        .setFriction(TOP_FRICTION)
        .setRestitution(TOP_RESTITUTION),
      body,
    );
    tops.push(body);
  }
  return tops;
}

// ───── Drama scoring ─────
// Pure spin-decay battles never produce knockouts, so the score keys
// off duration + spread + final-duel length instead.
function scoreDrama({ survivorOrder, eliminationFrames, battleFrames }) {
  const seconds = battleFrames / FPS;
  let s = 0;

  // Sweet-spot duration centered on 28s, full credit ±5s, half ±12s.
  s += 1 - Math.min(1, Math.abs(seconds - 28) / 12);

  // Spread: stddev of elimination frames. Larger = deaths fan out across
  // the timeline rather than bunching at one moment.
  const ef = eliminationFrames.filter((f, i) => i !== survivorOrder[0] && f > 0);
  if (ef.length > 1) {
    const mean = ef.reduce((a, b) => a + b, 0) / ef.length;
    const varr = ef.reduce((a, b) => a + (b - mean) ** 2, 0) / ef.length;
    const std = Math.sqrt(varr);
    s += Math.min(1.5, std / (battleFrames * 0.2));
  }

  // Final duel — gap between #2 and #1 going out (or surviving to cap).
  if (ef.length >= 1) {
    const sorted = ef.slice().sort((a, b) => a - b);
    const lastElim = sorted[sorted.length - 1];
    const penultimate = sorted.length >= 2 ? sorted[sorted.length - 2] : 0;
    const finalDuelFrames = lastElim - penultimate;
    s += Math.min(1.5, finalDuelFrames / (FPS * 3));
  }

  return s;
}

// ───── Utility ─────
function quatMul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

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
