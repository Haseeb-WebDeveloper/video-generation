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
export const RACE_TRACK_VERSION = 3;

// World gravity: tilted so +X is downhill. TRACK_TILT_DEG = 22 gives an
// effective downslope acceleration of g*sin(22°) ≈ 3.67 m/s². On a 350-unit
// track with the multi-section obstacle field, this produces a ~80-100s
// race — slow enough for a multi-shot edit, fast enough that no section
// drags. Steeper = race finishes too quickly to cover with cuts; shallower
// = trailing balls get stuck in the funnel section forever.
const TRACK_TILT_DEG = 16;
const GRAVITY_MAG = 9.81;

const TRACK_LEN = 200; // x in [0, TRACK_LEN] — short straight run
const TRACK_HALF_Z = 11; // z in [-TRACK_HALF_Z, +TRACK_HALF_Z]
const FLOOR_Y = 0;
// Platform-edge lip height. The reference (ref.jpeg) has just a low
// marble edge around the lane, not a tall wall — the COLLIDER is still
// 4 units tall though, so balls launched by collisions can't fly off
// the side. Only the VISUAL is the low lip.
const WALL_HEIGHT_COLLIDER = 4;
const FINISH_X = TRACK_LEN - 6; // x value that counts as crossing the line
const KILL_Y = -5; // y below this = ball is gone (eliminated)

const BALL_R = 0.7;
const PEG_R = 0.5;
const PEG_H = 2.0;
const PIN_R = 0.35;
const PIN_H = 1.8;
const WALL_THICKNESS = 0.8;

// ───── Section spec — MUST mirror src/race-slides.tsx ─────
// Each section has a start/end x-coordinate and a kind. The obstacle
// generators below consume rand() in a fixed order per kind, so the same
// seed reproduces identical layouts between this script and the renderer.
// To add a new kind: update SECTIONS here AND in race-slides.tsx, then
// add matching generator functions in both. Bump RACE_TRACK_VERSION.
const SECTIONS = [
  // Four DIFFERENT obstacle kinds across the 200-unit straight run.
  // Earlier "wedges + pins repeated" looked monotonous; now each section
  // has a visually distinct kind so the race has texture.
  { kind: "pillars", x0: 14,  x1: 55  }, // tall thin marble pillars
  { kind: "plinths", x0: 55,  x1: 100 }, // low landscape marble plinths
  { kind: "cones",   x0: 100, x1: 140 }, // marble cone bumpers
  { kind: "spheres", x0: 140, x1: 180 }, // fixed marble spheres
  // 180 → 194 open final stretch to the finish line.
];

// Race timing.
const FPS = 60;
const MAX_RACE_SECONDS = 120; // safety cap; with the longer track, balls
// stuck in funnel sections can take a while — generous cap so they finish.
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

  // Debug: how far did the stuck balls actually get? Helps tune obstacle
  // tightness — bottlenecked balls cluster at one section boundary.
  const stuckXs = [];
  for (let i = 0; i < N; i++) {
    if (!finished.has(i)) {
      const off = ((raceFrames - 1) * N + i) * 7;
      stuckXs.push({ i, x: Math.round(bake[off]), y: Math.round(bake[off + 1]) });
    }
  }
  if (stuckXs.length > 0) {
    console.log(
      `  stuck @ ` +
        stuckXs
          .sort((a, b) => a.x - b.x)
          .map((s) => `i${s.i}:${s.x}`)
          .join(" "),
    );
  }

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
        FLOOR_Y + WALL_HEIGHT_COLLIDER / 2,
        zSign * (TRACK_HALF_Z + 0.5),
      ),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(TRACK_LEN / 2, WALL_HEIGHT_COLLIDER / 2, 0.5)
        .setFriction(0.3)
        .setRestitution(0.2),
      wall,
    );
  }

  // Back wall (start gate) at x = -1, so balls placed at x ∈ [0, 6] can't
  // roll uphill out of bounds during the initial settle.
  const back = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(-1, FLOOR_Y + WALL_HEIGHT_COLLIDER / 2, 0),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.5, WALL_HEIGHT_COLLIDER / 2, TRACK_HALF_Z)
      .setFriction(0.2)
      .setRestitution(0.4),
    back,
  );

  // Finish backstop just beyond FINISH_X so balls actually collect there
  // visually rather than rolling off the edge of the world after crossing.
  const front = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(
      TRACK_LEN + 0.5,
      FLOOR_Y + WALL_HEIGHT_COLLIDER / 2,
      0,
    ),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.5, WALL_HEIGHT_COLLIDER / 2, TRACK_HALF_Z)
      .setFriction(0.3)
      .setRestitution(0.15),
    front,
  );

  // Dispatch to per-section obstacle generators. Order matters — each
  // generator consumes rand() in a fixed sequence so the renderer (which
  // re-runs the same RNG with the same seed) places its visual meshes
  // exactly on top of the physics colliders.
  for (const section of SECTIONS) {
    if (section.kind === "pillars") buildPillars(world, rand, section);
    else if (section.kind === "plinths") buildPlinths(world, rand, section);
    else if (section.kind === "cones") buildCones(world, rand, section);
    else if (section.kind === "spheres") buildSpheres(world, rand, section);
  }
}

// Pillars: vertical thin marble columns. Physics collider is a cylinder
// (radius PEG_R, height PEG_H), visual on the slides side draws a tall
// thin marble cuboid in the same spot.
function buildPillars(world, rand, section) {
  const ROW_DX = 7;
  const ROW_DZ = 5;
  const rows = Math.floor((section.x1 - section.x0) / ROW_DX);
  for (let row = 0; row < rows; row++) {
    const x = section.x0 + row * ROW_DX;
    const zOffset = row % 2 === 0 ? 0 : ROW_DZ / 2;
    for (let z = -TRACK_HALF_Z + 2.5; z <= TRACK_HALF_Z - 2.5; z += ROW_DZ) {
      const skip = rand();
      if (skip > 0.55) continue;
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(
          x,
          FLOOR_Y + PEG_H / 2,
          z + zOffset,
        ),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cylinder(PEG_H / 2, PEG_R)
          .setFriction(0.18)
          .setRestitution(0.55),
        body,
      );
    }
  }
}

// Plinths: low marble bars laid flat, oriented LANDSCAPE along x (long
// edge along the lane). Physics collider is a wide short cuboid; balls
// roll OVER the short ones near the edges but bounce off the taller
// centerline ones.
function buildPlinths(world, rand, section) {
  const ROW_DX = 11;
  const rows = Math.floor((section.x1 - section.x0) / ROW_DX);
  for (let row = 0; row < rows; row++) {
    const x = section.x0 + ROW_DX / 2 + row * ROW_DX;
    // Two plinths per row, randomly placed at different z positions.
    const slots = [-TRACK_HALF_Z + 3, -2, 3, TRACK_HALF_Z - 3];
    const used = new Set();
    const count = 2 + (rand() < 0.5 ? 0 : 1);
    for (let n = 0; n < count; n++) {
      let slot;
      do {
        slot = Math.floor(rand() * slots.length);
      } while (used.has(slot));
      used.add(slot);
      const z = slots[slot] + (rand() - 0.5) * 1.2;
      const halfW = 1.6;
      const halfH = 0.6;
      const halfD = 0.6;
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(x, FLOOR_Y + halfH, z),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(halfW, halfH, halfD)
          .setFriction(0.2)
          .setRestitution(0.4),
        body,
      );
    }
  }
}

// Cones: short marble cones (rendered as cones on slides side). Physics
// collider is approximated by a small cylinder at the base — close enough
// since balls only collide with the lower portion of the cone in
// practice.
function buildCones(world, rand, section) {
  const ROW_DX = 6;
  const ROW_DZ = 4.5;
  const rows = Math.floor((section.x1 - section.x0) / ROW_DX);
  for (let row = 0; row < rows; row++) {
    const x = section.x0 + row * ROW_DX;
    const zOffset = row % 2 === 0 ? 0 : ROW_DZ / 2;
    for (let z = -TRACK_HALF_Z + 2.5; z <= TRACK_HALF_Z - 2.5; z += ROW_DZ) {
      const skip = rand();
      if (skip > 0.5) continue;
      const radius = PEG_R * 0.9;
      const height = 1.6;
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(
          x,
          FLOOR_Y + height / 2,
          z + zOffset,
        ),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cylinder(height / 2, radius)
          .setFriction(0.2)
          .setRestitution(0.6),
        body,
      );
    }
  }
}

// Spheres: fixed marble spheres acting as bumpers. Physics collider is
// a sphere of the same radius. Sphere bumpers redirect balls in clean
// arcs (no flat faces to stick to) so this section "feels" different
// from the cylindrical-peg sections.
function buildSpheres(world, rand, section) {
  const ROW_DX = 7;
  const ROW_DZ = 5;
  const rows = Math.floor((section.x1 - section.x0) / ROW_DX);
  for (let row = 0; row < rows; row++) {
    const x = section.x0 + row * ROW_DX;
    const zOffset = row % 2 === 0 ? 0 : ROW_DZ / 2;
    for (let z = -TRACK_HALF_Z + 3; z <= TRACK_HALF_Z - 3; z += ROW_DZ) {
      const skip = rand();
      if (skip > 0.55) continue;
      const radius = 0.85;
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(
          x,
          FLOOR_Y + radius,
          z + zOffset,
        ),
      );
      world.createCollider(
        RAPIER.ColliderDesc.ball(radius)
          .setFriction(0.15)
          .setRestitution(0.7),
        body,
      );
    }
  }
}

// Wedge field: sparse triangular-prism pegs (physics is still a cylinder
// — the triangle is purely a render thing). Loose spacing so balls
// accelerate freely.
function buildWedges(world, rand, section) {
  const ROW_DX = 9;
  const ROW_DZ = 6;
  const rows = Math.floor((section.x1 - section.x0) / ROW_DX);
  for (let row = 0; row < rows; row++) {
    const x = section.x0 + row * ROW_DX;
    const zOffset = row % 2 === 0 ? 0 : ROW_DZ / 2;
    const zJitter = (rand() - 0.5) * 1.5;
    for (let z = -TRACK_HALF_Z + 3; z <= TRACK_HALF_Z - 3; z += ROW_DZ) {
      const skip = rand();
      const xJitter = (rand() - 0.5) * 1.2;
      if (skip > 0.6) continue;
      const peg = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(
          x + xJitter,
          FLOOR_Y + PEG_H / 2,
          z + zOffset + zJitter,
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

// Pin field: dense smaller pegs in a tight grid. More collisions per
// second so the field really shuffles here.
function buildPins(world, rand, section) {
  const ROW_DX = 5;
  const ROW_DZ = 4;
  const rows = Math.floor((section.x1 - section.x0) / ROW_DX);
  for (let row = 0; row < rows; row++) {
    const x = section.x0 + row * ROW_DX;
    const zOffset = row % 2 === 0 ? 0 : ROW_DZ / 2;
    for (let z = -TRACK_HALF_Z + 2.5; z <= TRACK_HALF_Z - 2.5; z += ROW_DZ) {
      const skip = rand();
      if (skip > 0.55) continue;
      const pin = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(
          x,
          FLOOR_Y + PIN_H / 2,
          z + zOffset,
        ),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cylinder(PIN_H / 2, PIN_R)
          .setFriction(0.15)
          .setRestitution(0.65),
        pin,
      );
    }
  }
}

// Zigzag walls: short partial walls protruding alternately from +Z and -Z
// sides, forcing balls to weave. Each wall is shorter than the track
// half-width so there's always a passage on one side.
function buildZigzag(world, rand, section) {
  const STEP = 13;
  const count = Math.floor((section.x1 - section.x0) / STEP);
  for (let i = 0; i < count; i++) {
    const x = section.x0 + STEP / 2 + i * STEP;
    const zSign = i % 2 === 0 ? -1 : 1;
    const protrude = 6 + rand() * 3; // 6–9 units into the 24-wide lane;
    //                                   passage stays ≥ 15 units wide so
    //                                   the field can squeeze through.
    const wallCenterZ =
      zSign * (TRACK_HALF_Z - protrude / 2);
    const wall = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(
        x,
        FLOOR_Y + WALL_HEIGHT_COLLIDER / 3,
        wallCenterZ,
      ),
    );
    // Low friction + low restitution = balls hitting the wall face slide
    // along it toward the opening instead of getting stuck or pinging
    // backward against gravity. This was the main jam in the v2 track.
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(WALL_THICKNESS / 2, WALL_HEIGHT_COLLIDER / 3, protrude / 2)
        .setFriction(0.06)
        .setRestitution(0.1),
      wall,
    );
  }
}

// V-funnels: pairs of angled walls forming a V whose narrow end faces
// downhill. Balls pile up at the narrow gap, then squeeze through, which
// produces dramatic lead changes.
function buildFunnels(world, rand, section) {
  const SPACING = 18;
  const count = Math.floor((section.x1 - section.x0) / SPACING);
  for (let i = 0; i < count; i++) {
    const cx = section.x0 + SPACING / 2 + i * SPACING;
    const gap = 6 + rand() * 2; // 6–8 unit gap (vs 3–4.5 before; balls were
    //                           jamming the narrow opening en masse)
    const armLen = 8;
    const armAngle = 0.4; // ~23° from track-axis (gentler angle)
    for (const sign of [-1, 1]) {
      // Wall goes from (cx, ±halfZ) inward toward (cx + delta, ±gap/2).
      // Place a cuboid at the midpoint with rotation around Y.
      const midX = cx + (armLen / 2) * Math.sin(armAngle);
      const midZ = sign * (TRACK_HALF_Z - (armLen / 2) * Math.cos(armAngle));
      const targetZ = sign * (gap / 2);
      // Compute rotation so the wall extends from outer-side to inner-gap.
      const dx = midX - cx;
      const dz = midZ - targetZ;
      const rotY = Math.atan2(dx, dz);
      const wall = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(midX, FLOOR_Y + WALL_HEIGHT_COLLIDER / 3, midZ)
          .setRotation({ x: 0, y: Math.sin(rotY / 2), z: 0, w: Math.cos(rotY / 2) }),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(WALL_THICKNESS / 2, WALL_HEIGHT_COLLIDER / 3, armLen / 2)
          .setFriction(0.06)
          .setRestitution(0.1),
        wall,
      );
    }
  }
}

// Mixed: a sparser wedge field with a few interspersed pins. Last section
// before the finish — meant to feel like the chaos winding down.
function buildMixed(world, rand, section) {
  buildWedges(world, rand, { ...section, x1: section.x0 + (section.x1 - section.x0) * 0.6 });
  buildPins(world, rand, { ...section, x0: section.x0 + (section.x1 - section.x0) * 0.5 });
}

function spawnGrid({ world, count, rand }) {
  const balls = [];
  // 6 balls per row keeps the field tightly packed across the lane's z
  // width (24 units), so even 24-ball fields fit in four rows entirely
  // within the open start stretch (x < 10).
  const PER_ROW = 6;
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / PER_ROW);
    const col = i % PER_ROW;
    const x = 1.5 + row * 1.9;
    const z = -10 + col * 4 + (rand() - 0.5) * 0.4;
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
