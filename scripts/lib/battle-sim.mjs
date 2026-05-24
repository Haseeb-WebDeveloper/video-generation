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
export const INIT_SPIN = 280;  // fast, energetic launch + big spin budget for long matches
const SPIN_JITTER = 6;         // near-uniform start; outcome decided by clashes
const STOP_THRESHOLD = 18;     // KO tops while still visibly spinning (realistic) instead of letting them crawl to a near-stop
const STOP_DWELL_FRAMES = 10;  // ~0.33s @ 30fps
const ANGULAR_DAMPING = 0.007; // slower natural decay → the fight lasts
const ANGULAR_DAMPING_JITTER = 0.024;
const LINEAR_DAMPING = 0.22;
const TOP_FRICTION = 0.02;
const TOP_RESTITUTION = 0.62; // solid clash with ricochet, less pinball-bouncy (realistic)
const FLOOR_FRICTION = 0.10;
const FLOOR_RESTITUTION = 0.05;
const WALL_FRICTION = 0.10;
const WALL_RESTITUTION = 0.78;

// Continuous stir keeps the battle dynamic (tops wander & re-collide all over
// the arena — no center bias, so the fight isn't always in the middle).
const NUDGE_INTERVAL = 14;
const NUDGE_STRENGTH = 4.0;
// Endgame magnet: ONLY when the last few tops remain, they drift toward the
// survivors' shared midpoint so the finish is a real clash — but at wherever
// they happen to be, so each round ends in a different spot instead of every
// round piling up at the arena center.
const SEEK_WHEN_ALIVE = 3;
const SEEK_STRENGTH = 0.34;

// Output/bake rate. Physics still steps at 1/60 (PHYS_PER_FRAME sub-steps per
// recorded frame) so the tuned dynamics are unchanged — we just record every
// other step. Halving the output frame rate halves render time.
export const FPS = 30;
const PHYS_PER_FRAME = 2;
const PHYS_DT = 1 / 60;
const MAX_BATTLE_SECONDS = 70;
const MAX_FRAMES = MAX_BATTLE_SECONDS * FPS;
// Beat where the lone winner spins alone before the battle ends / reveal.
export const VICTORY_HOLD = 75; // ~2.5s @ 30fps

let _rapierReady = false;
export async function initRapier() {
  if (_rapierReady) return;
  await RAPIER.init();
  _rapierReady = true;
}

function quatFromAxisAngle(ax, ay, az, angle) {
  const h = angle / 2, s = Math.sin(h);
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(h) };
}
function quatMul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
function rotateVec(q, v) {
  // v' = q * v * q^-1  (q unit)
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}
// Distance from the body center to the floor tip (matches POINT_Y in the
// renderer: the visual point is at local y = -TOP_HEIGHT/2).
const PIVOT_OFFSET = TOP_HEIGHT * 0.5;

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
  const handleToIndex = new Map();
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
    const col = world.createCollider(
      RAPIER.ColliderDesc.cylinder(TOP_HEIGHT / 2, TOP_RADIUS)
        .setDensity(1.0)
        .setFriction(TOP_FRICTION)
        .setRestitution(TOP_RESTITUTION)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      body,
    );
    handleToIndex.set(col.handle, i);
    tops.push(body);
  }
  return { tops, handleToIndex };
}

const LEAN_ANGLE = 0.62;   // ~35° rest lean for a stopped top
const LEAN_FRAMES = 13;    // how long the topple-lean takes (~0.43s @ 30fps)

function killTop(i, frame, reason, body, ctx, rand) {
  const { eliminated, eliminationFrames, eliminationReasons, elimOrder, leanAxis, leanStart } = ctx;
  eliminated.add(i);
  eliminationFrames[i] = frame;
  eliminationReasons[i] = reason;
  elimOrder.push(i);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  // Record a lean: the top tilts onto its rim like a real top that ran out of
  // spin (flag still visible). The visual tilt is composited in the bake; the
  // collider stays an upright cylinder so the dead top remains a bumpable
  // obstacle that slides realistically when a live top hits it.
  const a = rand() * Math.PI * 2;
  leanAxis[i] = { x: Math.cos(a), z: Math.sin(a) };
  leanStart[i] = frame;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

// Simulate one battle. `items` is only used for its length (participant count).
// Returns { bake, survivorOrder, eliminationFrames, eliminationReasons, battleFrames }.
export function simulateBattle({ count, seed }) {
  const N = count;
  const rand = mulberry32(seed);
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  buildArena(world);
  const { tops, handleToIndex } = spawnRing(world, N, rand);
  const eventQueue = new RAPIER.EventQueue(true);

  const bake = new Float32Array(MAX_FRAMES * N * 8);
  const eliminationFrames = new Array(N).fill(-1);
  const eliminationReasons = new Array(N).fill(null);
  const eliminated = new Set();
  const slowStreak = new Array(N).fill(0);
  const elimOrder = [];
  const leanAxis = new Array(N).fill(null);
  const leanStart = new Array(N).fill(-1);
  const ctx = { eliminated, eliminationFrames, eliminationReasons, elimOrder, leanAxis, leanStart };
  const collisions = []; // { frame, type:"top"|"wall", strength } for SFX

  // Per-collision spin loss: a clash bleeds spin from both tops, scaled by
  // impact strength, so hits MATTER but don't instantly gut a top — kept gentle
  // so collisions ACCUMULATE into a long, escalating fight instead of deciding
  // the match in the opening pile-up. Base + strength term.
  const SPIN_LOSS_BASE = 0.05;
  const SPIN_LOSS_STR = 0.08;

  world.timestep = PHYS_DT;
  let frame = 0;
  let pstep = 0;          // physics step counter (1/60), for nudge cadence
  let winnerLockFrame = -1;
  for (; frame < MAX_FRAMES; frame++) {
    // Two physics sub-steps (at 1/60) per recorded (30fps) frame — keeps the
    // tuned dynamics identical while halving the output frame count.
    for (let sub = 0; sub < PHYS_PER_FRAME; sub++) {
      world.step(eventQueue);

      // ── Collision events → spin loss + record for SFX (battle-local frame) ──
      eventQueue.drainCollisionEvents((h1, h2, started) => {
        if (!started) return;
        const i1 = handleToIndex.get(h1);
        const i2 = handleToIndex.get(h2);
        const topTop = i1 !== undefined && i2 !== undefined;
        let strength = 0;
        for (const idx of [i1, i2]) {
          if (idx === undefined || eliminated.has(idx)) continue;
          const b = tops[idx];
          strength = Math.max(strength, Math.hypot(b.linvel().x, b.linvel().z));
        }
        const strNorm = Math.min(1, strength / 8);
        if (topTop) {
          // Final-two showdown: ease the spin drain so the last duel is a
          // drawn-out, suspenseful 1v1 instead of ending in a hit or two.
          const duelFactor = N - eliminated.size <= 2 ? 0.4 : 1;
          const loss = (SPIN_LOSS_BASE + SPIN_LOSS_STR * strNorm) * duelFactor;
          for (const idx of [i1, i2]) {
            if (idx === undefined || eliminated.has(idx)) continue;
            const b = tops[idx];
            const av = b.angvel();
            b.setAngvel({ x: av.x, y: av.y * (1 - loss), z: av.z }, true);
          }
        }
        collisions.push({ frame, type: topTop ? "top" : "wall", strength: strNorm });
      });

      const doNudge = pstep > 30 && pstep % NUDGE_INTERVAL === 0;
      // Endgame magnet target: the midpoint of the surviving tops, active only
      // once the field is down to the last few. This pulls them together for a
      // climactic clash wherever they are — not the fixed arena center — so the
      // ending differs every round.
      const aliveCount = N - eliminated.size;
      let seekX = 0, seekZ = 0, seekOn = false;
      if (aliveCount > 1 && aliveCount <= SEEK_WHEN_ALIVE) {
        let n = 0;
        for (let j = 0; j < N; j++) {
          if (eliminated.has(j)) continue;
          const p = tops[j].translation();
          seekX += p.x; seekZ += p.z; n++;
        }
        seekX /= n; seekZ /= n;
        seekOn = true;
      }
      for (let i = 0; i < N; i++) {
        const body = tops[i];
        const lv = body.linvel();
        const av = body.angvel();
        // Alive AND eliminated tops are kept physically upright (the collider is
        // a bumpable cylinder); the dead-top LEAN is purely visual (in the bake).
        if (eliminated.has(i)) {
          body.setLinvel({ x: lv.x, y: 0, z: lv.z }, true);
          body.setAngvel({ x: 0, y: 0, z: 0 }, true);
          continue;
        }
        const energy = Math.max(0, Math.min(1, Math.abs(av.y) / INIT_SPIN));
        let nx = lv.x, nz = lv.z;
        if (seekOn) {
          const pos = body.translation();
          const dx = seekX - pos.x, dz = seekZ - pos.z;
          const d = Math.hypot(dx, dz) || 1;
          nx += (dx / d) * SEEK_STRENGTH * energy;
          nz += (dz / d) * SEEK_STRENGTH * energy;
        }
        if (doNudge) {
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
      pstep++;
    }

    for (let i = 0; i < N; i++) {
      const body = tops[i];
      const t = body.translation();
      const r = body.rotation();
      const av = body.angvel();
      const spinMag = Math.abs(av.y);
      const isElim = eliminated.has(i);
      const energy = isElim ? 0 : Math.max(0, Math.min(1, spinMag / INIT_SPIN));

      // Visual transform. Alive = physics. Eliminated = tilt onto the rim,
      // pivoting about the floor tip so the flag stays visible and nothing
      // clips through the table.
      let qx = r.x, qy = r.y, qz = r.z, qw = r.w;
      let px = t.x, py = t.y, pz = t.z;
      if (isElim && leanAxis[i]) {
        const tt = Math.min(1, (frame - leanStart[i]) / LEAN_FRAMES);
        const angle = easeOutCubic(tt) * LEAN_ANGLE;
        const lq = quatFromAxisAngle(leanAxis[i].x, 0, leanAxis[i].z, angle);
        const out = quatMul(lq, { x: qx, y: qy, z: qz, w: qw });
        qx = out.x; qy = out.y; qz = out.z; qw = out.w;
        // Pivot about the tip: tip = center - (0, PIVOT_OFFSET, 0); leaned
        // center = tip + lean·(0, PIVOT_OFFSET, 0).
        const off2 = rotateVec(lq, { x: 0, y: PIVOT_OFFSET, z: 0 });
        px = t.x + off2.x;
        py = (t.y - PIVOT_OFFSET) + off2.y;
        pz = t.z + off2.z;
      }

      const off = (frame * N + i) * 8;
      bake[off + 0] = px; bake[off + 1] = py; bake[off + 2] = pz;
      bake[off + 3] = qx; bake[off + 4] = qy; bake[off + 5] = qz; bake[off + 6] = qw;
      bake[off + 7] = energy;

      if (isElim) continue;
      if (t.y < KILL_Y) {
        killTop(i, frame, "fell", body, ctx, rand);
        continue;
      }
      if (spinMag < STOP_THRESHOLD) {
        slowStreak[i] += 1;
        if (slowStreak[i] >= STOP_DWELL_FRAMES) {
          killTop(i, frame, "stopped", body, ctx, rand);
        }
      } else {
        slowStreak[i] = 0;
      }
    }

    // Once only the winner is left, keep simulating for a VICTORY_HOLD beat so
    // the lone champion is seen spinning alone among the fallen tops before the
    // reveal — instead of cutting to the winner the instant #2 stops.
    if (eliminated.size >= N - 1) {
      if (winnerLockFrame < 0) winnerLockFrame = frame;
      if (frame - winnerLockFrame >= VICTORY_HOLD) { frame++; break; }
    }
  }

  for (let i = 0; i < N; i++) {
    if (!eliminated.has(i)) { eliminationFrames[i] = frame; eliminationReasons[i] = "stopped"; }
  }
  const survivors = [];
  for (let i = 0; i < N; i++) if (!eliminated.has(i)) survivors.push(i);
  const survivorOrder = [...survivors, ...elimOrder.slice().reverse()];
  const battleFrames = frame;
  const trimmed = new Float32Array(bake.buffer, 0, battleFrames * N * 8).slice();

  return { bake: trimmed, survivorOrder, eliminationFrames, eliminationReasons, battleFrames, collisions };
}
