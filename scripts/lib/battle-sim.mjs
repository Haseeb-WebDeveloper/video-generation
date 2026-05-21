// Shared spinning-top battle simulator core. Used by battle-roll.mjs (single
// battle) and tournament-roll.mjs (bracket of battles). Pure & deterministic:
// same items + seed → identical bake.
//
// Bake layout: Float32Array, 8 floats per top per frame:
//   [x, y, z, qx, qy, qz, qw, energy]   energy = clamp(|angvel.y|/INIT_SPIN,0,1)

import RAPIER from "@dimforge/rapier3d-compat";

export const BATTLE_ARENA_VERSION = 2;

// ── Arena ──
export const FLOOR_Y = 0;
export const ARENA_HALF_X = 10.0;
export const ARENA_HALF_Z = 5.625;
const WALL_THICKNESS = 0.6;
const WALL_HEIGHT = 1.6;
const KILL_Y = -4;

export const TOP_RADIUS = 0.85;
export const TOP_HEIGHT = 1.0;
const SPAWN_RADIUS = 2.5;
const SPAWN_Y = TOP_HEIGHT / 2 + 0.25;

const SLEEP_LINVEL_THRESHOLD = 0.015;

// ── Spin / damping model ──
export const INIT_SPIN = 60;
const SPIN_JITTER = 18;
const STOP_THRESHOLD = 4;
const STOP_DWELL_FRAMES = 20;
const ANGULAR_DAMPING = 0.010;
const ANGULAR_DAMPING_JITTER = 0.020;
const LINEAR_DAMPING = 0.22;
const TOP_FRICTION = 0.02;
const TOP_RESTITUTION = 0.82;
const FLOOR_FRICTION = 0.10;
const FLOOR_RESTITUTION = 0.05;
const WALL_FRICTION = 0.10;
const WALL_RESTITUTION = 0.78;

// Continuous stir keeps the battle dynamic (tops wander & re-collide).
const NUDGE_INTERVAL = 18;
const NUDGE_STRENGTH = 3.2;

export const FPS = 60;
const MAX_BATTLE_SECONDS = 70;
const MAX_FRAMES = MAX_BATTLE_SECONDS * FPS;

let _rapierReady = false;
export async function initRapier() {
  if (_rapierReady) return;
  await RAPIER.init();
  _rapierReady = true;
}

export function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildArena(world) {
  const floor = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, FLOOR_Y - 0.5, 0),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(ARENA_HALF_X + 2, 0.5, ARENA_HALF_Z + 2)
      .setFriction(FLOOR_FRICTION)
      .setRestitution(FLOOR_RESTITUTION),
    floor,
  );
  const walls = [
    { cx: 0, cz: ARENA_HALF_Z + WALL_THICKNESS / 2, hx: ARENA_HALF_X + WALL_THICKNESS, hz: WALL_THICKNESS / 2 },
    { cx: 0, cz: -(ARENA_HALF_Z + WALL_THICKNESS / 2), hx: ARENA_HALF_X + WALL_THICKNESS, hz: WALL_THICKNESS / 2 },
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

function spawnRing(world, count, rand) {
  const tops = [];
  for (let i = 0; i < count; i++) {
    const theta = (i / count) * Math.PI * 2 + (rand() - 0.5) * 0.12;
    const r = SPAWN_RADIUS + (rand() - 0.5) * 0.2;
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    const spin = INIT_SPIN + (rand() - 0.5) * 2 * SPIN_JITTER;
    const angDamp = ANGULAR_DAMPING + (rand() - 0.5) * 2 * ANGULAR_DAMPING_JITTER;
    const inward = 3.0 + rand() * 1.8;
    const tangSign = rand() < 0.5 ? 1 : -1;
    const inX = -Math.cos(theta), inZ = -Math.sin(theta);
    const tanX = -Math.sin(theta) * tangSign, tanZ = Math.cos(theta) * tangSign;
    const rAng = rand() * Math.PI * 2;
    let dirX = inX * 0.4 + tanX * 0.8 + Math.cos(rAng) * 0.4;
    let dirZ = inZ * 0.4 + tanZ * 0.8 + Math.sin(rAng) * 0.4;
    const dl = Math.hypot(dirX, dirZ) || 1;
    dirX /= dl; dirZ /= dl;
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

function killTop(i, frame, reason, body, eliminated, eliminationFrames, eliminationReasons, elimOrder) {
  eliminated.add(i);
  eliminationFrames[i] = frame;
  eliminationReasons[i] = reason;
  elimOrder.push(i);
  // Leave the body in place & dynamic — a stopped top stays as a collidable
  // obstacle. Just kill its spin.
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
}

// Simulate one battle. `items` is only used for its length (participant count).
// Returns { bake, survivorOrder, eliminationFrames, eliminationReasons, battleFrames }.
export function simulateBattle({ count, seed }) {
  const N = count;
  const rand = mulberry32(seed);
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  buildArena(world);
  const tops = spawnRing(world, N, rand);

  const bake = new Float32Array(MAX_FRAMES * N * 8);
  const eliminationFrames = new Array(N).fill(-1);
  const eliminationReasons = new Array(N).fill(null);
  const eliminated = new Set();
  const slowStreak = new Array(N).fill(0);
  const elimOrder = [];

  let frame = 0;
  for (; frame < MAX_FRAMES; frame++) {
    world.step();

    const doNudge = frame > 30 && frame % NUDGE_INTERVAL === 0;
    for (let i = 0; i < N; i++) {
      const body = tops[i];
      const lv = body.linvel();
      const av = body.angvel();
      const vx = lv.x, vz = lv.z;
      if (eliminated.has(i)) {
        body.setLinvel({ x: vx, y: 0, z: vz }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        continue;
      }
      let nx = vx, nz = vz;
      if (doNudge) {
        const energy = Math.max(0, Math.min(1, Math.abs(av.y) / INIT_SPIN));
        const ang = rand() * Math.PI * 2;
        const mag = NUDGE_STRENGTH * energy;
        nx += Math.cos(ang) * mag;
        nz += Math.sin(ang) * mag;
      }
      const lateral = Math.hypot(nx, nz);
      if (lateral < SLEEP_LINVEL_THRESHOLD) { nx = 0; nz = 0; }
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
      bake[off + 0] = t.x; bake[off + 1] = t.y; bake[off + 2] = t.z;
      bake[off + 3] = r.x; bake[off + 4] = r.y; bake[off + 5] = r.z; bake[off + 6] = r.w;
      bake[off + 7] = energy;

      if (eliminated.has(i)) continue;
      if (t.y < KILL_Y) {
        killTop(i, frame, "fell", body, eliminated, eliminationFrames, eliminationReasons, elimOrder);
        continue;
      }
      if (spinMag < STOP_THRESHOLD) {
        slowStreak[i] += 1;
        if (slowStreak[i] >= STOP_DWELL_FRAMES) {
          killTop(i, frame, "stopped", body, eliminated, eliminationFrames, eliminationReasons, elimOrder);
        }
      } else {
        slowStreak[i] = 0;
      }
    }

    if (eliminated.size >= N - 1) { frame++; break; }
  }

  for (let i = 0; i < N; i++) {
    if (!eliminated.has(i)) { eliminationFrames[i] = frame; eliminationReasons[i] = "stopped"; }
  }
  const survivors = [];
  for (let i = 0; i < N; i++) if (!eliminated.has(i)) survivors.push(i);
  const survivorOrder = [...survivors, ...elimOrder.slice().reverse()];
  const battleFrames = frame;
  const trimmed = new Float32Array(bake.buffer, 0, battleFrames * N * 8).slice();

  return { bake: trimmed, survivorOrder, eliminationFrames, eliminationReasons, battleFrames };
}
