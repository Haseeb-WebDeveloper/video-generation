import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import * as THREE from "three";
import { Suspense, useMemo } from "react";
import {
  AbsoluteFill,
  Audio,
  continueRender,
  delayRender,
  Easing,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
import { Episode } from "./episode";

const { fontFamily: INTER } = loadFont();

// ─── Track constants. MUST stay in sync with scripts/race-roll.mjs.
// If you change either side the existing bakes are invalidated. We don't
// import from race-roll because it's a Node script (.mjs); the cost of
// duplication is small for ~15 constants. TRACK_TILT_DEG only matters in
// the simulator (it sets the gravity vector); the visual scene leaves the
// floor flat, so we don't store it here.
const TRACK_LEN = 110;
const TRACK_HALF_Z = 12;
const FLOOR_Y = 0;
const WALL_HEIGHT = 4;
const FINISH_X = TRACK_LEN - 5;
const BALL_R = 0.7;
const PEG_R = 0.45;
const PEG_H = 2.0;
const PEG_X_MIN = 15;
const PEG_X_MAX = TRACK_LEN - 18;
const PEG_ROW_DX = 9;
const PEG_ROW_DZ = 6;

const FPS = 60;
const COUNTDOWN_FRAMES = 3 * FPS; // 3s pre-race grid hold + 3-2-1-GO
const PODIUM_FRAMES = 6 * FPS; // 6s podium hold after last ball settles
const POST_FINISH_HOLD_FRAMES = 2 * FPS; // 2s after #1 crosses before podium camera

// Per-ball palette. Indexed by item index modulo length, so even
// large grids get visually distinct colors. Tuned for visibility on the
// dark backdrop (high saturation, mid-bright lightness).
const BALL_PALETTE = [
  "#ff4d4d",
  "#ffb74d",
  "#ffe24d",
  "#7fdb6a",
  "#4dd0e1",
  "#5b9eff",
  "#9b6dff",
  "#ff6dc7",
  "#ff8b3a",
  "#c8f53a",
  "#3affc8",
  "#3a9fff",
  "#d63afc",
  "#ffd23a",
  "#3afc7f",
  "#ff3a8b",
  "#3afcef",
  "#fc8b3a",
  "#aaff3a",
  "#3a64ff",
  "#fc3a3a",
  "#fcd83a",
  "#3afc3a",
  "#fc3ad8",
  "#3afcb5",
  "#fc843a",
  "#843afc",
  "#3a84fc",
  "#fc3a84",
  "#84fc3a",
  "#fc3afc",
  "#3afcfc",
];

// ─── Public API ────────────────────────────────────────────────
export function totalFrames(episode: Episode): number {
  if (!episode.raceResult) return COUNTDOWN_FRAMES + PODIUM_FRAMES;
  return (
    COUNTDOWN_FRAMES +
    episode.raceResult.raceFrames +
    POST_FINISH_HOLD_FRAMES +
    PODIUM_FRAMES
  );
}

export const RaceSlidesComposition: React.FC<{ episode: Episode }> = ({
  episode,
}) => {
  return (
    <AbsoluteFill style={{ background: "#0a0e1c", fontFamily: INTER }}>
      <ThreeCanvas width={1920} height={1080}>
        <Scene episode={episode} />
      </ThreeCanvas>
      <HUD episode={episode} />
      {episode.audioPath && (
        <Audio src={staticFile(episode.audioPath)} volume={episode.audioVolume ?? 0.35} />
      )}
    </AbsoluteFill>
  );
};

// ─── Bake loader via React Suspense (throw-promise pattern).
// useState+useEffect raced with Remotion's frame capture — by the time
// continueRender fired and React flushed setBake, the headless renderer
// had already snapshot the DOM with fallback positions. Suspense forces
// the entire scene to wait for the binary before any frame paints.
const bakeCache = new Map<string, Float32Array | Promise<Float32Array>>();

function loadBake(path: string): Float32Array {
  const existing = bakeCache.get(path);
  if (existing instanceof Float32Array) return existing;
  if (existing instanceof Promise) throw existing;
  const handle = delayRender(`race-bake:${path}`);
  const promise = fetch(staticFile(path))
    .then((r) => r.arrayBuffer())
    .then((buf) => {
      const arr = new Float32Array(buf);
      bakeCache.set(path, arr);
      continueRender(handle);
      return arr;
    })
    .catch((err) => {
      continueRender(handle);
      throw err;
    });
  bakeCache.set(path, promise);
  throw promise;
}

// ─── Three.js scene ────────────────────────────────────────────
const Scene: React.FC<{ episode: Episode }> = ({ episode }) => {
  const frame = useCurrentFrame();
  const bake = useBake(episode.raceBakePath);
  const N = episode.items.length;
  const result = episode.raceResult;

  const pegs = useMemo(
    () => computePegs(episode.raceSeed ?? 0),
    [episode.raceSeed],
  );

  // Translate the absolute Remotion frame into a position into the bake.
  // Before the race starts we read frame 0 (grid). After the race ends we
  // freeze on the last frame (collected at the finish line).
  const raceFrame = result
    ? Math.max(
        0,
        Math.min(
          result.raceFrames - 1,
          frame - COUNTDOWN_FRAMES,
        ),
      )
    : 0;

  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight
        position={[20, 40, 30]}
        intensity={1.2}
        castShadow={false}
      />
      <directionalLight position={[-30, 20, -20]} intensity={0.35} />

      <CameraRig episode={episode} />

      <Track pegs={pegs} />

      {Array.from({ length: N }).map((_, i) => (
        <Ball
          key={i}
          index={i}
          color={BALL_PALETTE[i % BALL_PALETTE.length]}
          label={String(i + 1)}
          bake={bake}
          frame={raceFrame}
          numBalls={N}
        />
      ))}
    </>
  );
};

const Track: React.FC<{ pegs: Array<[number, number]> }> = ({ pegs }) => {
  return (
    <>
      {/* Floor — slightly tinted so balls stand out against it. */}
      <mesh position={[TRACK_LEN / 2, FLOOR_Y - 0.5, 0]}>
        <boxGeometry args={[TRACK_LEN, 1, TRACK_HALF_Z * 2]} />
        <meshStandardMaterial color="#141a2c" roughness={0.85} metalness={0.05} />
      </mesh>
      {/* Glowing track edge strips so the lane reads at any camera angle. */}
      {[-1, 1].map((sign) => (
        <mesh
          key={sign}
          position={[TRACK_LEN / 2, FLOOR_Y + 0.02, sign * TRACK_HALF_Z]}
        >
          <boxGeometry args={[TRACK_LEN, 0.05, 0.3]} />
          <meshBasicMaterial color="#5ed1ff" />
        </mesh>
      ))}
      {/* Side walls. */}
      {[-1, 1].map((sign) => (
        <mesh
          key={sign}
          position={[
            TRACK_LEN / 2,
            FLOOR_Y + WALL_HEIGHT / 2,
            sign * (TRACK_HALF_Z + 0.5),
          ]}
        >
          <boxGeometry args={[TRACK_LEN, WALL_HEIGHT, 1]} />
          <meshStandardMaterial color="#1f2942" roughness={0.7} />
        </mesh>
      ))}
      {/* Back wall (start gate). */}
      <mesh position={[-1, FLOOR_Y + WALL_HEIGHT / 2, 0]}>
        <boxGeometry args={[1, WALL_HEIGHT, TRACK_HALF_Z * 2 + 1]} />
        <meshStandardMaterial color="#27314d" roughness={0.6} />
      </mesh>
      {/* Front wall (backstop). */}
      <mesh position={[TRACK_LEN + 0.5, FLOOR_Y + WALL_HEIGHT / 2, 0]}>
        <boxGeometry args={[1, WALL_HEIGHT, TRACK_HALF_Z * 2 + 1]} />
        <meshStandardMaterial color="#27314d" roughness={0.6} />
      </mesh>
      {/* Finish-line stripe on the floor. */}
      <mesh position={[FINISH_X, FLOOR_Y + 0.03, 0]}>
        <boxGeometry args={[0.4, 0.05, TRACK_HALF_Z * 2]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
      {/* Pegs. */}
      {pegs.map(([x, z], i) => (
        <mesh key={i} position={[x, FLOOR_Y + PEG_H / 2, z]}>
          <cylinderGeometry args={[PEG_R, PEG_R, PEG_H, 16]} />
          <meshStandardMaterial color="#f5b35a" roughness={0.4} metalness={0.2} />
        </mesh>
      ))}
    </>
  );
};

const Ball: React.FC<{
  index: number;
  color: string;
  label: string;
  bake: Float32Array | null;
  frame: number;
  numBalls: number;
}> = ({ index, color, label, bake, frame, numBalls }) => {
  // Pull this frame's transform from the bake. Layout: [frame][ball][xyz qx qy qz qw]
  let x = 2,
    y = BALL_R + 0.5,
    z = 0;
  let qx = 0,
    qy = 0,
    qz = 0,
    qw = 1;
  if (bake) {
    const off = (frame * numBalls + index) * 7;
    x = bake[off + 0];
    y = bake[off + 1];
    z = bake[off + 2];
    qx = bake[off + 3];
    qy = bake[off + 4];
    qz = bake[off + 5];
    qw = bake[off + 6];
  } else {
    // Pre-load fallback: best-guess grid position so the scene composes
    // without a flash of stacked-at-origin balls during the first frame.
    const row = Math.floor(index / 5);
    const col = index % 5;
    x = 2 + row * 2.2;
    z = -10 + col * 5;
    y = BALL_R + 0.5 + row * 0.1;
  }

  const quaternion = useMemo(
    () => new THREE.Quaternion(qx, qy, qz, qw),
    [qx, qy, qz, qw],
  );

  return (
    <group position={[x, y, z]} quaternion={quaternion}>
      <mesh>
        <sphereGeometry args={[BALL_R, 24, 18]} />
        <meshStandardMaterial color={color} roughness={0.35} metalness={0.15} />
      </mesh>
      {/* A counter-rotated badge so the number stays readable while the
          ball itself spins. Parented to the ball group but with the inverse
          quaternion so it cancels the roll. */}
      <BallBadge
        quaternion={quaternion}
        label={label}
        invertColor={isLightColor(color)}
      />
    </group>
  );
};

const BallBadge: React.FC<{
  quaternion: THREE.Quaternion;
  label: string;
  invertColor: boolean;
}> = ({ quaternion, label, invertColor }) => {
  const invQuat = useMemo(() => quaternion.clone().invert(), [quaternion]);
  return (
    <group quaternion={invQuat}>
      <Text
        position={[0, BALL_R + 0.05, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={0.7}
        color={invertColor ? "#0a0e1c" : "#ffffff"}
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.05}
        outlineColor={invertColor ? "#ffffff" : "#0a0e1c"}
      >
        {label}
      </Text>
    </group>
  );
};

// ─── Camera ────────────────────────────────────────────────────
// Three phases, no hard cuts in v1 (cuts come later via cross-faded
// overlay frames). The camera linearly interpolates between an aerial
// grid view and a side-tracking shot, then settles into a podium hold
// after the race finishes.
const CameraRig: React.FC<{ episode: Episode }> = ({ episode }) => {
  const frame = useCurrentFrame();
  const { camera } = useThree();
  const result = episode.raceResult;
  const raceFrames = result?.raceFrames ?? 0;
  const finishFrames = result?.finishFrames ?? [];
  const winnerFinishFrame =
    finishFrames.length > 0 ? finishFrames[0] : raceFrames;

  // Mean X of the leading 3 balls — a cinematic "tracking the leader pack"
  // shot rather than locking to #1 (which often pops too far ahead).
  // Sampled from the bake via... wait, scope. We re-derive from the same
  // estimate the simulator's racers reach: at race-fraction f, the leader
  // pack is roughly at f * TRACK_LEN. Good enough for v1; replace with
  // actual bake-sampled position if it looks wrong.
  const raceFrame = Math.max(0, frame - COUNTDOWN_FRAMES);
  const raceFraction =
    raceFrames > 0 ? Math.min(1, raceFrame / raceFrames) : 0;
  const leaderX = 4 + raceFraction * (FINISH_X - 4);

  // Phase weights (0..1).
  const inCountdown = frame < COUNTDOWN_FRAMES;
  const postFinish = result && raceFrame >= winnerFinishFrame;
  const podiumPhase =
    result && raceFrame >= winnerFinishFrame + POST_FINISH_HOLD_FRAMES;

  // ─── Camera waypoints ───
  // GRID: high aerial 3/4 view of the starting grid.
  const grid = {
    pos: [12, 18, 28] as [number, number, number],
    look: [8, 1, 0] as [number, number, number],
  };
  // TRACK: side tracking shot, leader-pack centered.
  const track = {
    pos: [leaderX - 6, 8, 22] as [number, number, number],
    look: [leaderX + 6, 1.5, 0] as [number, number, number],
  };
  // FINISH: close-up of the finish line for the photo finish.
  const finish = {
    pos: [FINISH_X - 4, 6, 18] as [number, number, number],
    look: [FINISH_X, 1, 0] as [number, number, number],
  };
  // PODIUM: pulled back from the finish line for the winner reveal.
  const podium = {
    pos: [FINISH_X + 6, 9, 16] as [number, number, number],
    look: [FINISH_X - 2, 1.5, 0] as [number, number, number],
  };

  let pos: [number, number, number];
  let look: [number, number, number];
  if (inCountdown) {
    // Slow drift on the grid: lerp from grid to grid (gentle parallax via
    // a small z slide) so the static phase still feels alive.
    const t = Easing.inOut(Easing.ease)(frame / COUNTDOWN_FRAMES);
    pos = [
      lerp(grid.pos[0], grid.pos[0] + 2, t),
      grid.pos[1],
      lerp(grid.pos[2], grid.pos[2] - 4, t),
    ];
    look = grid.look;
  } else if (podiumPhase) {
    pos = podium.pos;
    look = podium.look;
  } else if (postFinish) {
    // 2s zoom from track shot into the finish frame.
    const t = Easing.inOut(Easing.ease)(
      (raceFrame - winnerFinishFrame) / POST_FINISH_HOLD_FRAMES,
    );
    pos = lerp3(track.pos, finish.pos, t);
    look = lerp3(track.look, finish.look, t);
  } else {
    // Race body: blend out of grid into track shot over the first ~1s,
    // then pure tracking for the rest of the race.
    const blendFrames = 60;
    const t = Math.min(1, (frame - COUNTDOWN_FRAMES) / blendFrames);
    const ease = Easing.inOut(Easing.ease)(t);
    pos = lerp3(grid.pos, track.pos, ease);
    look = lerp3(grid.look, track.look, ease);
  }

  camera.position.set(pos[0], pos[1], pos[2]);
  camera.lookAt(look[0], look[1], look[2]);
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.fov = 35;
    camera.updateProjectionMatrix();
  }
  return null;
};

// ─── HUD overlay ───────────────────────────────────────────────
const HUD: React.FC<{ episode: Episode }> = ({ episode }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const result = episode.raceResult;

  // Countdown digit logic. We show "3" for the first second, "2" for the
  // second, "1" for the third, and "GO!" at the moment of launch.
  const countdownActive = frame < COUNTDOWN_FRAMES;
  const secondsLeft = Math.ceil((COUNTDOWN_FRAMES - frame) / fps);
  const goLabel = frame < COUNTDOWN_FRAMES - fps * 0.2 ? `${secondsLeft}` : "GO!";

  // Winner banner — pops in 0.8s after #1 crosses.
  const raceFrame = Math.max(0, frame - COUNTDOWN_FRAMES);
  const winnerIndex = result?.finishOrder[0];
  const winnerFinishFrame = result?.finishFrames?.[0] ?? Number.MAX_SAFE_INTEGER;
  const winnerVisible =
    result != null &&
    winnerIndex != null &&
    raceFrame >= winnerFinishFrame + fps * 0.5;

  const winnerOpacity = winnerVisible
    ? Math.min(1, (raceFrame - winnerFinishFrame - fps * 0.5) / (fps * 0.5))
    : 0;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {/* Title bar — episode title across the top during countdown. */}
      {countdownActive && (
        <div
          style={{
            position: "absolute",
            top: 64,
            left: 0,
            right: 0,
            textAlign: "center",
            color: "#ffffff",
            textShadow: "0 4px 24px rgba(0,0,0,0.85)",
            opacity: interpolate(frame, [0, 20], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          <div
            style={{
              fontSize: 36,
              letterSpacing: 6,
              opacity: 0.7,
              textTransform: "uppercase",
              fontWeight: 600,
            }}
          >
            {episode.title[0]}
          </div>
          <div
            style={{
              fontSize: 72,
              fontWeight: 900,
              letterSpacing: 2,
            }}
          >
            {episode.title[1]}
          </div>
        </div>
      )}

      {/* Countdown digit. */}
      {countdownActive && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: 0,
            right: 0,
            transform: "translateY(-50%)",
            textAlign: "center",
            color: "#f5b35a",
            fontSize: 320,
            fontWeight: 900,
            letterSpacing: -8,
            textShadow: "0 8px 48px rgba(0,0,0,0.9)",
            opacity: countdownPulseOpacity(frame, fps),
          }}
        >
          {goLabel}
        </div>
      )}

      {/* Winner banner after #1 crosses. */}
      {winnerOpacity > 0 && winnerIndex != null && (
        <div
          style={{
            position: "absolute",
            top: 80,
            left: 0,
            right: 0,
            textAlign: "center",
            color: "#ffffff",
            opacity: winnerOpacity,
            textShadow: "0 6px 32px rgba(0,0,0,0.95)",
          }}
        >
          <div
            style={{
              fontSize: 32,
              letterSpacing: 8,
              opacity: 0.7,
              textTransform: "uppercase",
              fontWeight: 600,
            }}
          >
            Winner
          </div>
          <div
            style={{
              fontSize: 96,
              fontWeight: 900,
              color: "#f5b35a",
              marginTop: 8,
            }}
          >
            {episode.items[winnerIndex].title}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};

// ─── Helpers ───────────────────────────────────────────────────
function computePegs(seed: number): Array<[number, number]> {
  const rand = mulberry32(seed);
  // The order of rand() calls MUST exactly match scripts/race-roll.mjs's
  // buildTrack so peg positions visually align with their physics counter-
  // parts. Specifically: the simulator consumes zJitter and then per-cell
  // (skip-roll, x-jitter) for every cell in the row, and only places a peg
  // if skip-roll <= 0.6.
  const out: Array<[number, number]> = [];
  const numRows = Math.floor((PEG_X_MAX - PEG_X_MIN) / PEG_ROW_DX);
  for (let row = 0; row < numRows; row++) {
    const x = PEG_X_MIN + row * PEG_ROW_DX;
    const offset = row % 2 === 0 ? 0 : PEG_ROW_DZ / 2;
    const zJitter = (rand() - 0.5) * 1.5;
    for (let z = -TRACK_HALF_Z + 3; z <= TRACK_HALF_Z - 3; z += PEG_ROW_DZ) {
      const skip = rand();
      const xJitter = (rand() - 0.5) * 1.2;
      if (skip > 0.6) continue;
      out.push([x + xJitter, z + offset + zJitter]);
    }
  }
  return out;
}

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function isLightColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Standard luma; >0.6 → use dark text.
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

function countdownPulseOpacity(frame: number, fps: number): number {
  const phaseFrame = frame % fps;
  // Punch in for the first 200ms of each second, hold, then fade out the
  // last 200ms so the digit has a heartbeat.
  if (phaseFrame < fps * 0.2)
    return interpolate(phaseFrame, [0, fps * 0.2], [0, 1]);
  if (phaseFrame > fps * 0.8)
    return interpolate(phaseFrame, [fps * 0.8, fps], [1, 0]);
  return 1;
}
