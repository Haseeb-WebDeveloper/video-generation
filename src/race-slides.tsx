import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
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
// duplication is small for ~20 constants. TRACK_TILT_DEG only matters in
// the simulator (it sets the gravity vector); the visual scene leaves the
// floor flat, so we don't store it here.
const TRACK_LEN = 200;
const TRACK_HALF_Z = 11;
const FLOOR_Y = 0;
const WALL_HEIGHT = 0.9; // platform-edge lip — see ref.jpeg, not a "wall"
const FINISH_X = TRACK_LEN - 6;
const BALL_R = 0.7;
// PEG_R / PIN_R / PEG_H / PIN_H are still set in scripts/race-roll.mjs
// for the physics colliders. Visual sizes are decided per obstacle kind
// in the Track component.

// ─── Section spec — MUST mirror scripts/race-roll.mjs ─────
// Order, kinds, and rand() consumption inside each generator must match
// the simulator exactly. Adding a new section here without the matching
// physics generator (or vice versa) breaks the visual/collider alignment.
type SectionKind = "pillars" | "plinths" | "cones" | "spheres";
type Section = { kind: SectionKind; x0: number; x1: number };
const SECTIONS: Section[] = [
  { kind: "pillars", x0: 14, x1: 55 },
  { kind: "plinths", x0: 55, x1: 100 },
  { kind: "cones", x0: 100, x1: 140 },
  { kind: "spheres", x0: 140, x1: 180 },
];

const FPS = 60;
const COUNTDOWN_FRAMES = 10 * FPS; // 10s — title flyby + 3-2-1-GO
const PODIUM_FRAMES = 8 * FPS; // 8s podium hero shot — short, just reveal
const MIN_FINISH_WINDOW = 4 * FPS; // race body holds at least 4s past
// the winner so #2 and #3 visibly cross before the camera cuts to podium.
const AUDIO_FADE_FRAMES = 90; // matches flow/bar templates so post-mux fade is identical

// Per-ball palette. Used only as a fallback when an item has no imagePath
// (the normal case has covers via the build-episode pipeline). Tuned to sit
// well against the LIGHT arena backdrop — mid-saturation, mid-lightness,
// no fluorescent neons. Indexed by item index modulo length.
const BALL_PALETTE = [
  "#d94d4d",
  "#e0883a",
  "#c9b736",
  "#5fa84a",
  "#34a8a1",
  "#3d7fd1",
  "#7a5acf",
  "#cc5aa3",
  "#b25034",
  "#8aa83a",
  "#34a87a",
  "#3473b7",
  "#9c46b7",
  "#c79334",
  "#34b574",
  "#bf3b6a",
  "#34a8a8",
  "#b56e34",
  "#85a834",
  "#3454b7",
  "#bf3434",
  "#bfa334",
  "#34a834",
  "#a8348a",
  "#34a890",
  "#a85f34",
  "#5f34a8",
  "#3470a8",
  "#a83470",
  "#70a834",
  "#a834a8",
  "#34a8c4",
];

// ─── Arena palette ─────────────────────────────────────────────
// Brushed-steel arena look. Surfaces are a polished silver-grey metal
// with fine perpendicular brushing lines. Surround is a deep neutral
// grey so the metallic floor catches the key light and reads as
// highly reflective. Flag-textured spheres pop hard against the cool
// metal.
const COLOR_BG = "#b8bdc2";
const COLOR_STEEL_BASE = "#c2c6cc";
const COLOR_STEEL_HIGHLIGHT = "#dde0e3";
const COLOR_STEEL_SHADOW = "#8e9298";
const COLOR_OUTSIDE = "#7a7d82";

// Cartoon obstacle palette — bright primary/secondary colors so the
// course reads as a kid's toy/playset rather than a serious industrial
// surface. One color per obstacle kind keeps the four sections clearly
// distinct.
const COLOR_OBS_PILLAR = "#ef4444"; // red
const COLOR_OBS_PLINTH = "#3b82f6"; // blue
const COLOR_OBS_CONE = "#f59e0b"; // orange
const COLOR_OBS_SPHERE = "#facc15"; // yellow

// ─── Public API ────────────────────────────────────────────────
// raceEndFrame returns the LAST frame of the race body the composition
// uses — i.e. when we cut to podium. We don't wait for all 20 balls to
// finish (some take 30s+ past the winner); we hold just long enough for
// the front of the pack (top ~3) to visibly cross, plus a small buffer.
export function raceEndFrame(episode: Episode): number {
  const result = episode.raceResult;
  if (!result || result.finishFrames.length === 0) return result?.raceFrames ?? 0;
  const winner = result.finishFrames[0];
  const third = result.finishFrames[Math.min(2, result.finishFrames.length - 1)];
  const minHold = winner + MIN_FINISH_WINDOW;
  return Math.min(result.raceFrames, Math.max(third + FPS, minHold));
}

export function totalFrames(episode: Episode): number {
  if (!episode.raceResult) return COUNTDOWN_FRAMES + PODIUM_FRAMES;
  return COUNTDOWN_FRAMES + raceEndFrame(episode) + PODIUM_FRAMES;
}

export const RaceSlidesComposition: React.FC<{ episode: Episode }> = ({
  episode,
}) => {
  const { durationInFrames } = useVideoConfig();
  const baseVolume = episode.audioVolume ?? 0.35;
  const fadeVolume = (f: number) => {
    const fadeIn = Math.min(1, f / AUDIO_FADE_FRAMES);
    const fadeOut = Math.min(1, (durationInFrames - f) / AUDIO_FADE_FRAMES);
    return baseVolume * Math.max(0, Math.min(fadeIn, fadeOut));
  };
  return (
    <AbsoluteFill style={{ background: COLOR_BG, fontFamily: INTER }}>
      <Suspense fallback={<AbsoluteFill style={{ background: COLOR_BG }} />}>
        <ThreeCanvas width={1920} height={1080}>
          <Scene episode={episode} />
        </ThreeCanvas>
      </Suspense>
      <HUD episode={episode} />
      {episode.audioPath && (
        <Audio src={staticFile(episode.audioPath)} volume={fadeVolume} loop />
      )}
    </AbsoluteFill>
  );
};

// ─── Bake loader. We delay the entire render via delayRender until the
// binary is fetched, then cache it module-scope so all subsequent frames
// see it immediately. Prior attempts via React Suspense from inside
// ThreeCanvas resulted in a stuck-in-fallback frame — R3F maintains its
// own Suspense boundary that swallowed our throw. Plain delayRender +
// module cache is the simplest pattern that survives Remotion's per-
// frame mount/unmount in headless rendering.
const bakeCache = new Map<string, Float32Array>();
const bakeLoaders = new Map<string, Promise<Float32Array>>();

function loadBake(path: string): Float32Array {
  // Throws a Promise on the first call to suspend React (caught by the
  // outer <Suspense> above ThreeCanvas). Second call after the promise
  // resolves returns the cached Float32Array synchronously. Returning
  // `null` and "trying again next frame" did not work — Remotion's still
  // capture snapshots the current React tree even after delayRender
  // releases, so balls rendered at fallback grid positions and were off-
  // screen for most camera shots.
  const cached = bakeCache.get(path);
  if (cached) return cached;
  let promise = bakeLoaders.get(path);
  if (!promise) {
    const handle = delayRender(`race-bake:${path}`);
    promise = fetch(staticFile(path))
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const arr = new Float32Array(buf);
        bakeCache.set(path, arr);
        continueRender(handle);
        return arr;
      })
      .catch((err) => {
        console.error("Race bake fetch failed", err);
        continueRender(handle);
        throw err;
      });
    bakeLoaders.set(path, promise);
  }
  throw promise;
}


// ─── Three.js scene ────────────────────────────────────────────
const Scene: React.FC<{ episode: Episode }> = ({ episode }) => {
  const frame = useCurrentFrame();
  // loadBake suspends via a thrown Promise on the first call; the outer
  // <Suspense> at AbsoluteFill catches it. By the time control reaches
  // this line, the cache is populated and we get a real Float32Array.
  const bake = episode.raceBakePath ? loadBake(episode.raceBakePath) : null;
  const N = episode.items.length;
  const result = episode.raceResult;

  const obstacles = useMemo(
    () => computeObstacles(episode.raceSeed ?? 0),
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
      <color attach="background" args={[COLOR_BG]} />
      <ArenaLights />

      <CameraRig episode={episode} bake={bake} numBalls={N} />

      <Track obstacles={obstacles} />

      <BallField
        episode={episode}
        bake={bake}
        frame={raceFrame}
        N={N}
      />
    </>
  );
};

// Loads all cover textures in one drei batch. Suspends until every cover
// is ready — caught by the <Suspense> at the AbsoluteFill level, which is
// where Remotion observes Suspense and pauses frame capture. (Putting the
// Suspense inside ThreeCanvas left Remotion seeing a "resolved" tree and
// capturing the fallback render with untextured balls.)
const BallField: React.FC<{
  episode: Episode;
  bake: Float32Array | null;
  frame: number;
  N: number;
}> = ({ episode, bake, frame, N }) => {
  const coverPaths = useMemo(
    () =>
      episode.items.map((it) =>
        it.imagePath ? staticFile(it.imagePath) : staticFile("bg-0.jpeg"),
      ),
    [episode.items],
  );
  const coverTextures = useTexture(coverPaths);
  useMemo(() => {
    const list = Array.isArray(coverTextures) ? coverTextures : [coverTextures];
    for (const t of list) {
      if (t) {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
      }
    }
  }, [coverTextures]);

  return (
    <>
      {Array.from({ length: N }).map((_, i) => (
        <Ball
          key={i}
          index={i}
          color={BALL_PALETTE[i % BALL_PALETTE.length]}
          texture={
            episode.items[i].imagePath
              ? (Array.isArray(coverTextures)
                  ? coverTextures[i]
                  : coverTextures) ?? null
              : null
          }
          bake={bake}
          frame={frame}
          numBalls={N}
        />
      ))}
    </>
  );
};

const ArenaLights: React.FC = () => {
  // Studio lighting for the brushed-steel look. Stronger key + brighter
  // hemisphere than the marble version so the metal reads as polished
  // (not dark). Without an env-map IBL the metalness mostly mirrors the
  // hemisphere, so keep the upper sky tint bright and cool.
  return (
    <>
      <hemisphereLight args={["#e0e4e8", "#7c8088", 1.2]} />
      <directionalLight position={[70, 60, -20]} intensity={1.3} />
      <directionalLight position={[-50, 40, 35]} intensity={0.6} />
      <directionalLight position={[0, 25, 55]} intensity={0.35} />
    </>
  );
};

const Track: React.FC<{ obstacles: Obstacle[] }> = ({ obstacles }) => {
  // Carrara textures for the three marble surfaces. Each surface gets its
  // own seed/repeat so the veining doesn't tile obviously — the floor
  // shows large slow veins (wide repeat), walls show medium ones, and
  // each obstacle gets a tight pattern via a shared texture (sharing one
  // texture instance across all obstacles keeps GPU memory low).
  // Sandblasted steel — fine speckle grain, no directional pattern.
  // Higher repeat values are fine here because the speckle is
  // self-similar at any scale (unlike brushed steel where repeating
  // lines would tile obviously).
  const floorTex = useMemo(
    () =>
      makeSteelTexture({
        size: 1024,
        repeatX: 10,
        repeatY: 2,
        seed: 0x9c7e1131,
      }),
    [],
  );
  const wallTex = useMemo(
    () =>
      makeSteelTexture({
        size: 512,
        repeatX: 12,
        repeatY: 1,
        seed: 0x33f57921,
      }),
    [],
  );
  // (blockTex removed — obstacles now use solid cartoon colors instead
  // of the sandblasted steel map.)

  // Deterministic random rotation per peg so triangles point in varied
  // directions. The seed is irrelevant here (visual only — the physics
  // collider is a circle in race-roll), so we just hash by index.
  return (
    <>
      {/* Dark studio floor beyond the steel platform. Matte (rough 1.0)
          and dark so the polished steel of the lane reads as the
          brightest thing in frame. */}
      <mesh
        position={[TRACK_LEN / 2, FLOOR_Y - 1.2, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <planeGeometry args={[TRACK_LEN * 4, TRACK_HALF_Z * 16]} />
        <meshStandardMaterial color={COLOR_OUTSIDE} roughness={1.0} />
      </mesh>

      {/* Sandblasted steel floor — high roughness (matte), low metalness
          so the surface reads as "industrially textured silver" instead
          of a shiny mirror. Matches the reference image at
          public/sandblasted-stainless-steel-sheet-matte-finish.webp. */}
      <mesh position={[TRACK_LEN / 2, FLOOR_Y - 0.5, 0]}>
        <boxGeometry args={[TRACK_LEN, 1, TRACK_HALF_Z * 2]} />
        <meshStandardMaterial
          map={floorTex}
          roughness={0.78}
          metalness={0.25}
          color={COLOR_STEEL_BASE}
        />
      </mesh>

      {/* Steel platform edge lip on both sides. */}
      {[-1, 1].map((sign) => (
        <mesh
          key={sign}
          position={[
            TRACK_LEN / 2,
            FLOOR_Y + WALL_HEIGHT / 2,
            sign * (TRACK_HALF_Z + 0.35),
          ]}
        >
          <boxGeometry args={[TRACK_LEN, WALL_HEIGHT, 0.7]} />
          <meshStandardMaterial
            map={wallTex}
            roughness={0.8}
            metalness={0.22}
            color={COLOR_STEEL_BASE}
          />
        </mesh>
      ))}

      {/* Start and finish lips. */}
      <mesh position={[-0.5, FLOOR_Y + WALL_HEIGHT / 2, 0]}>
        <boxGeometry args={[0.7, WALL_HEIGHT, TRACK_HALF_Z * 2 + 1.4]} />
        <meshStandardMaterial
          map={wallTex}
          roughness={0.8}
          metalness={0.22}
          color={COLOR_STEEL_BASE}
        />
      </mesh>
      <mesh position={[TRACK_LEN + 0.5, FLOOR_Y + WALL_HEIGHT / 2, 0]}>
        <boxGeometry args={[0.7, WALL_HEIGHT, TRACK_HALF_Z * 2 + 1.4]} />
        <meshStandardMaterial
          map={wallTex}
          roughness={0.8}
          metalness={0.22}
          color={COLOR_STEEL_BASE}
        />
      </mesh>

      {/* Finish-line stripe — B&W checkerboard banner inset into the floor. */}
      <FinishLineStripe />

      {/* Section obstacles — bright cartoon plastic-toy colors. Each
          kind gets its own primary/secondary so the four sections read
          as distinctly different territory as the camera moves through.
          Slightly glossy material (roughness 0.35, no metalness) so the
          plastic catches light highlights cleanly without going chrome. */}
      {obstacles.map((o, i) => {
        if (o.kind === "pillar") {
          const h = 2.0;
          const w = 1.0;
          return (
            <mesh key={i} position={[o.x, FLOOR_Y + h / 2, o.z]}>
              <boxGeometry args={[w, h, w]} />
              <meshStandardMaterial
                color={COLOR_OBS_PILLAR}
                roughness={0.35}
                metalness={0.05}
              />
            </mesh>
          );
        }
        if (o.kind === "plinth") {
          return (
            <mesh key={i} position={[o.x, FLOOR_Y + 0.6, o.z]}>
              <boxGeometry args={[3.2, 1.2, 1.2]} />
              <meshStandardMaterial
                color={COLOR_OBS_PLINTH}
                roughness={0.35}
                metalness={0.05}
              />
            </mesh>
          );
        }
        if (o.kind === "cone") {
          return (
            <mesh key={i} position={[o.x, FLOOR_Y + 0.85, o.z]}>
              <coneGeometry args={[0.7, 1.7, 24]} />
              <meshStandardMaterial
                color={COLOR_OBS_CONE}
                roughness={0.32}
                metalness={0.05}
              />
            </mesh>
          );
        }
        // sphere
        return (
          <mesh key={i} position={[o.x, FLOOR_Y + 0.85, o.z]}>
            <sphereGeometry args={[0.85, 32, 20]} />
            <meshStandardMaterial
              color={COLOR_OBS_SPHERE}
              roughness={0.28}
              metalness={0.05}
            />
          </mesh>
        );
      })}
    </>
  );
};

const FinishLineStripe: React.FC = () => {
  const tex = useMemo(() => makeCheckerTexture(8, 2), []);
  return (
    <mesh
      position={[FINISH_X, FLOOR_Y + 0.025, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
    >
      <planeGeometry args={[1.6, TRACK_HALF_Z * 2]} />
      <meshStandardMaterial map={tex} roughness={0.7} />
    </mesh>
  );
};

// ─── Procedural textures ───────────────────────────────────────
// Sandblasted stainless-steel matte finish — see the reference image at
// public/sandblasted-stainless-steel-sheet-matte-finish.webp. The
// surface is a uniformly light silver covered in a FINE SPECKLE GRAIN
// (no directional brushing). We layer a base grey, soft tonal blotches
// for non-uniformity, then thousands of single-pixel speckles in
// alternating lighter / darker shades. The matte look comes from
// meshStandardMaterial having higher roughness (set in Track below).
function makeSteelTexture(opts: {
  size: number;
  repeatX?: number;
  repeatY?: number;
  seed: number;
}): THREE.CanvasTexture {
  const { size: SIZE, seed } = opts;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = COLOR_STEEL_BASE;
  ctx.fillRect(0, 0, SIZE, SIZE);

  const rand = mulberry32(seed);
  const highlight = hexToRgb(COLOR_STEEL_HIGHLIGHT);
  const shadow = hexToRgb(COLOR_STEEL_SHADOW);

  // Soft tonal blotches for non-uniformity — keeps the surface from
  // tiling visibly. Larger than the speckle, lower contrast.
  for (let i = 0; i < 14; i++) {
    const cx = rand() * SIZE;
    const cy = rand() * SIZE;
    const r = SIZE * (0.15 + rand() * 0.25);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const tint = rand() < 0.5 ? highlight : shadow;
    grad.addColorStop(0, `rgba(${tint.r},${tint.g},${tint.b},${0.06 + rand() * 0.08})`);
    grad.addColorStop(1, `rgba(${tint.r},${tint.g},${tint.b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, SIZE, SIZE);
  }

  // Fine speckle grain — thousands of single-pixel dots. Density is
  // proportional to texture area so 256/512/1024 textures look the same
  // visual coarseness at render distance.
  const speckles = Math.floor((SIZE * SIZE) / 6);
  for (let i = 0; i < speckles; i++) {
    const x = Math.floor(rand() * SIZE);
    const y = Math.floor(rand() * SIZE);
    const lighter = rand() < 0.5;
    const tint = lighter ? highlight : shadow;
    const alpha = 0.08 + rand() * 0.28;
    ctx.fillStyle = `rgba(${tint.r},${tint.g},${tint.b},${alpha})`;
    ctx.fillRect(x, y, 1, 1);
  }

  // A handful of slightly larger pits (2-3px) for incident character —
  // makes the sandblasted surface look like real metal, not pure noise.
  for (let i = 0; i < SIZE / 4; i++) {
    const x = rand() * SIZE;
    const y = rand() * SIZE;
    const r = 1 + rand() * 1.5;
    ctx.fillStyle = `rgba(${shadow.r},${shadow.g},${shadow.b},${0.15 + rand() * 0.2})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  if (opts.repeatX) tex.repeat.x = opts.repeatX;
  if (opts.repeatY) tex.repeat.y = opts.repeatY;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function makeCheckerTexture(
  cellsX: number,
  cellsY: number,
): THREE.CanvasTexture {
  const SIZE = 256;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  const cw = SIZE / cellsX;
  const ch = SIZE / cellsY;
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      ctx.fillStyle = (cx + cy) % 2 === 0 ? "#0a0a0a" : "#ffffff";
      ctx.fillRect(cx * cw, cy * ch, cw, ch);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function hexToRgb(hex: string) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

const Ball: React.FC<{
  index: number;
  color: string;
  texture: THREE.Texture | null;
  bake: Float32Array | null;
  frame: number;
  numBalls: number;
}> = ({ index, color, texture, bake, frame, numBalls }) => {
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
        <sphereGeometry args={[BALL_R, 48, 32]} />
        {texture ? (
          // Glassy-marble material — roughness 0.12 + a touch of metalness
          // gives a clear specular highlight from the key light, matching
          // the polished spheres in the reference image. Higher reflection
          // than the wood-aesthetic version because marble surfaces
          // bounce light back; the balls should look like wet glazed
          // stone, not vinyl.
          <meshStandardMaterial
            map={texture}
            roughness={0.12}
            metalness={0.15}
          />
        ) : (
          <meshStandardMaterial
            color={color}
            roughness={0.15}
            metalness={0.15}
          />
        )}
      </mesh>
    </group>
  );
};

// ─── Camera ────────────────────────────────────────────────────
// Three phases, no hard cuts in v1 (cuts come later via cross-faded
// overlay frames). The camera linearly interpolates between an aerial
// grid view and a side-tracking shot, then settles into a podium hold
// after the race finishes.
const CameraRig: React.FC<{
  episode: Episode;
  bake: Float32Array | null;
  numBalls: number;
}> = ({ episode, bake, numBalls }) => {
  const frame = useCurrentFrame();
  const { camera } = useThree();
  const result = episode.raceResult;
  const raceFrames = result?.raceFrames ?? 0;
  const finishFrames = result?.finishFrames ?? [];
  const winnerFinishFrame =
    finishFrames.length > 0 ? finishFrames[0] : raceFrames;

  // End of the race-body window (when we cut to podium). See
  // raceEndFrame — it's a tight cutoff a few seconds after the third
  // ball finishes, not "wait for everyone".
  const endFrame = result ? raceEndFrame(episode) : raceFrames;
  const raceFrame = Math.max(
    0,
    Math.min(endFrame > 0 ? endFrame - 1 : 0, frame - COUNTDOWN_FRAMES),
  );

  // Front-most ball x — the entire camera follows this one number now.
  const leaderX = bake
    ? maxLiveX(bake, raceFrame, numBalls)
    : 4 + (endFrame > 0 ? raceFrame / endFrame : 0) * (FINISH_X - 4);

  const inCountdown = frame < COUNTDOWN_FRAMES;
  const podiumPhase = result != null && frame >= COUNTDOWN_FRAMES + endFrame;
  // The last MIN_FINISH_WINDOW frames of race body slide the camera in
  // toward the finish line — same phase, different anchor.
  const postFinish = result != null && raceFrame >= winnerFinishFrame;

  let pos: [number, number, number];
  let look: [number, number, number];
  let fov = 48;

  if (inCountdown) {
    // Low 3/4 establishing shot of the starting grid. Slow drift gives
    // the otherwise-static countdown a sense of motion. y=3.2 puts the
    // lens just above ball height; z=14 angles in from the side for the
    // reference's 3/4 perspective.
    const t = Easing.inOut(Easing.ease)(frame / COUNTDOWN_FRAMES);
    pos = [lerp(-2, 1, t), 3.2, lerp(14, 11, t)];
    look = [6, 0.7, 0];
    fov = 55;
  } else if (podiumPhase) {
    // Hero shot of the front of the field at the finish line. Camera
    // sits INSIDE the platform, just before the finish lip, off to one
    // side. Frames the top finishers cleanly.
    pos = [FINISH_X - 11, 3.0, 8];
    look = [FINISH_X + 1, 0.7, 0];
    fov = 46;
  } else if (postFinish) {
    // Photo-finish window — camera stays AHEAD of the line at all times.
    // We anchor to FINISH_X so the lens points back as #2/#3 cross the
    // checkered stripe in front of it.
    pos = [FINISH_X + 14, 3.5, 5];
    look = [FINISH_X - 4, 0.7, 0];
    fov = 56;
  } else {
    // RACE BODY — REVERSE chase: camera sits AHEAD of the leader and
    // looks BACK at the approaching field. Balls roll TOWARD the lens
    // (the user's explicit request). Slight elevation (y=3.6) reads as
    // "broadcast handheld" rather than ball-level.
    pos = [leaderX + 14, 3.6, 4.5];
    look = [Math.max(0, leaderX - 6), 0.7, 0];
    fov = 56;
  }

  camera.position.set(pos[0], pos[1], pos[2]);
  camera.lookAt(look[0], look[1], look[2]);
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.fov = fov;
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
type Obstacle =
  | { kind: "pillar"; x: number; z: number }
  | { kind: "plinth"; x: number; z: number }
  | { kind: "cone"; x: number; z: number }
  | { kind: "sphere"; x: number; z: number };

function computeObstacles(seed: number): Obstacle[] {
  const rand = mulberry32(seed);
  const out: Obstacle[] = [];
  // CRITICAL: the order of rand() calls inside each section MUST match
  // scripts/race-roll.mjs's corresponding builder function exactly. If
  // they desync, visual obstacles will float in space disconnected from
  // their physics colliders.
  for (const section of SECTIONS) {
    if (section.kind === "pillars") genPillars(rand, section, out);
    else if (section.kind === "plinths") genPlinths(rand, section, out);
    else if (section.kind === "cones") genCones(rand, section, out);
    else if (section.kind === "spheres") genSpheres(rand, section, out);
  }
  return out;
}

function genPillars(rand: () => number, section: Section, out: Obstacle[]) {
  const ROW_DX = 7;
  const ROW_DZ = 5;
  const rows = Math.floor((section.x1 - section.x0) / ROW_DX);
  for (let row = 0; row < rows; row++) {
    const x = section.x0 + row * ROW_DX;
    const zOffset = row % 2 === 0 ? 0 : ROW_DZ / 2;
    for (let z = -TRACK_HALF_Z + 2.5; z <= TRACK_HALF_Z - 2.5; z += ROW_DZ) {
      const skip = rand();
      if (skip > 0.55) continue;
      out.push({ kind: "pillar", x, z: z + zOffset });
    }
  }
}

function genPlinths(rand: () => number, section: Section, out: Obstacle[]) {
  const ROW_DX = 11;
  const rows = Math.floor((section.x1 - section.x0) / ROW_DX);
  for (let row = 0; row < rows; row++) {
    const x = section.x0 + ROW_DX / 2 + row * ROW_DX;
    const slots = [-TRACK_HALF_Z + 3, -2, 3, TRACK_HALF_Z - 3];
    const used = new Set<number>();
    const count = 2 + (rand() < 0.5 ? 0 : 1);
    for (let n = 0; n < count; n++) {
      let slot;
      do {
        slot = Math.floor(rand() * slots.length);
      } while (used.has(slot));
      used.add(slot);
      const z = slots[slot] + (rand() - 0.5) * 1.2;
      out.push({ kind: "plinth", x, z });
    }
  }
}

function genCones(rand: () => number, section: Section, out: Obstacle[]) {
  const ROW_DX = 6;
  const ROW_DZ = 4.5;
  const rows = Math.floor((section.x1 - section.x0) / ROW_DX);
  for (let row = 0; row < rows; row++) {
    const x = section.x0 + row * ROW_DX;
    const zOffset = row % 2 === 0 ? 0 : ROW_DZ / 2;
    for (let z = -TRACK_HALF_Z + 2.5; z <= TRACK_HALF_Z - 2.5; z += ROW_DZ) {
      const skip = rand();
      if (skip > 0.5) continue;
      out.push({ kind: "cone", x, z: z + zOffset });
    }
  }
}

function genSpheres(rand: () => number, section: Section, out: Obstacle[]) {
  const ROW_DX = 7;
  const ROW_DZ = 5;
  const rows = Math.floor((section.x1 - section.x0) / ROW_DX);
  for (let row = 0; row < rows; row++) {
    const x = section.x0 + row * ROW_DX;
    const zOffset = row % 2 === 0 ? 0 : ROW_DZ / 2;
    for (let z = -TRACK_HALF_Z + 3; z <= TRACK_HALF_Z - 3; z += ROW_DZ) {
      const skip = rand();
      if (skip > 0.55) continue;
      out.push({ kind: "sphere", x, z: z + zOffset });
    }
  }
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

function maxLiveX(bake: Float32Array, frame: number, N: number): number {
  // x of the front-most still-on-the-track ball at this frame. Eliminated
  // balls (parked far below the kill plane) are skipped so the camera
  // doesn't snap to a stale position somewhere off the lane. Capped at the
  // finish so the camera stops advancing once the winner has crossed.
  let max = -Infinity;
  const base = frame * N * 7;
  for (let i = 0; i < N; i++) {
    const x = bake[base + i * 7];
    const y = bake[base + i * 7 + 1];
    if (y > -1 && x > max) max = x;
  }
  return Number.isFinite(max) ? Math.min(max, FINISH_X) : 0;
}


function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
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
