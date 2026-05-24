import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { useTexture, Environment, Lightformer } from "@react-three/drei";
import * as THREE from "three";
import { Suspense, useMemo } from "react";
import {
  AbsoluteFill,
  Audio,
  continueRender,
  delayRender,
  Easing,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
import { Episode } from "./episode";

const { fontFamily: INTER } = loadFont();

// ─── Arena constants. MUST stay in sync with scripts/battle-roll.mjs.
const FLOOR_Y = 0;
const ARENA_HALF_X = 10.0;       // visible play area spans x ∈ [-10, +10]
const ARENA_HALF_Z = 5.625;      // visible play area spans z ∈ [-5.625, +5.625]
const TOP_RADIUS = 0.85;
const TOP_HEIGHT = 1.0;

// 30fps output (bakes are also 30fps from battle-sim.mjs) — half the frames to
// render. Physics still simulated at 1/60 internally.
const FPS = 30;
const COUNTDOWN_FRAMES = 3 * FPS;  // snappy 3-2-1 (round cards build the hype)
const PODIUM_FRAMES = 4 * FPS;
const AUDIO_FADE_FRAMES = 1.5 * FPS;
// Must match VICTORY_HOLD in scripts/lib/battle-sim.mjs — the beat at the end
// of the battle where the lone winner spins alone before the reveal.
const VICTORY_HOLD = 75;

// Per-top accent palette — drives the colored equator band on each top
// and the leaderboard rank pill. Mid-saturated so they read as distinct
// without competing with the flag textures on the top face.
// Rich, saturated jewel tones rendered as polished metal (not pastel plastic).
const ACCENT_PALETTE = [
  "#c1121f", "#1d4ed8", "#059669", "#d97706", "#7c3aed", "#be185d",
  "#0d9488", "#b45309", "#dc2626", "#0891b2", "#ea580c", "#4f46e5",
  "#65a30d", "#e11d48", "#0e7490", "#a21caf", "#0369a1", "#ca8a04",
  "#16a34a", "#9333ea", "#b91c1c", "#c2410c", "#3730a3", "#15803d",
  "#155e75", "#92400e", "#6b21a8", "#4d7c0f", "#9f1239", "#db2777",
  "#1e40af", "#86198f",
];

// ─── Scene palette ─────────────────────────────────────────────
// Brushed steel arena. Backdrop barely matters since the rectangular
// floor fills the frame, but kept here in case the camera ever pulls
// back enough to show it.
const COLOR_BG = "#0a0c10";
const COLOR_STEEL_BASE = "#c2c6cc";
const COLOR_STEEL_HIGHLIGHT = "#e4e7eb";
const COLOR_STEEL_SHADOW = "#7c8088";

// ─── Public API ────────────────────────────────────────────────
export function totalFrames(episode: Episode): number {
  if (!episode.battleResult) return COUNTDOWN_FRAMES + PODIUM_FRAMES;
  return COUNTDOWN_FRAMES + episode.battleResult.battleFrames + PODIUM_FRAMES;
}

// Flip to true once the SFX files exist in public/audio/sfx/ (see SFX_FILES).
// Kept false by default so renders don't break on missing audio.
const SFX_ENABLED = true;
// whir.mp3 (looping spin ambience) is optional — only enable once it exists.
const SFX_WHIR_ENABLED = false;
const SFX_FILES = {
  hit: "audio/sfx/hit.mp3", // short top-on-top clink/clack
  wall: "audio/sfx/wall.mp3", // short wall thud
  whir: "audio/sfx/whir.mp3", // looping spin ambience bed
};
const SFX_MIN_GAP = 5; // frames between hit sounds (anti machine-gun)
const SFX_STRENGTH_MIN = 0.25; // ignore weak grazes

export const TopBattleSlidesComposition: React.FC<{
  episode: Episode;
  hideAudio?: boolean;
  collisions?: Array<{ frame: number; type: "top" | "wall"; strength: number }>;
}> = ({ episode, hideAudio, collisions }) => {
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
        <ThreeCanvas
          width={1920}
          height={1080}
          gl={{ toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.18 }}
        >
          <Scene episode={episode} />
        </ThreeCanvas>
      </Suspense>
      <HUD episode={episode} />
      {!hideAudio && episode.audioPath && (
        <Audio src={staticFile(episode.audioPath)} volume={fadeVolume} loop />
      )}
      {SFX_ENABLED && <BattleSfx collisions={collisions} battleFrames={episode.battleResult?.battleFrames ?? 0} />}
    </AbsoluteFill>
  );
};

// Sound-effect layer: a spin-ambience bed during the battle + one short hit
// sound per (throttled) collision, synced to the frames recorded in the bake.
const BattleSfx: React.FC<{
  collisions?: Array<{ frame: number; type: "top" | "wall"; strength: number }>;
  battleFrames: number;
}> = ({ collisions, battleFrames }) => {
  const hits = useMemo(() => {
    if (!collisions) return [];
    const out: Array<{ frame: number; type: "top" | "wall"; strength: number }> = [];
    let last = -100;
    for (const c of collisions) {
      if (c.strength < SFX_STRENGTH_MIN) continue;
      if (c.frame - last < SFX_MIN_GAP) continue;
      out.push(c);
      last = c.frame;
    }
    return out;
  }, [collisions]);
  return (
    <>
      {/* Spin ambience across the battle body (optional). */}
      {SFX_WHIR_ENABLED && (
        <Sequence from={COUNTDOWN_FRAMES} durationInFrames={Math.max(1, battleFrames)}>
          <Audio src={staticFile(SFX_FILES.whir)} volume={0.18} loop />
        </Sequence>
      )}
      {hits.map((c, i) => (
        <Sequence key={i} from={COUNTDOWN_FRAMES + c.frame} durationInFrames={30}>
          <Audio
            src={staticFile(c.type === "wall" ? SFX_FILES.wall : SFX_FILES.hit)}
            volume={0.35 + c.strength * 0.5}
          />
        </Sequence>
      ))}
    </>
  );
};

// ─── Bake loader ──────────────────────────────────────────────
const bakeCache = new Map<string, Float32Array>();
const bakeLoaders = new Map<string, Promise<Float32Array>>();

function loadBake(path: string): Float32Array {
  const cached = bakeCache.get(path);
  if (cached) return cached;
  let promise = bakeLoaders.get(path);
  if (!promise) {
    const handle = delayRender(`battle-bake:${path}`);
    promise = fetch(staticFile(path))
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const arr = new Float32Array(buf);
        bakeCache.set(path, arr);
        continueRender(handle);
        return arr;
      })
      .catch((err) => {
        console.error("Battle bake fetch failed", err);
        continueRender(handle);
        throw err;
      });
    bakeLoaders.set(path, promise);
  }
  throw promise;
}

const STRIDE = 8;

function readTop(bake: Float32Array, frame: number, idx: number, N: number) {
  const off = (frame * N + idx) * STRIDE;
  return {
    x: bake[off + 0],
    y: bake[off + 1],
    z: bake[off + 2],
    qx: bake[off + 3],
    qy: bake[off + 4],
    qz: bake[off + 5],
    qw: bake[off + 6],
    energy: bake[off + 7],
  };
}

// ─── Three.js scene ────────────────────────────────────────────
const Scene: React.FC<{ episode: Episode }> = ({ episode }) => {
  const frame = useCurrentFrame();
  const bake = episode.battleBakePath ? loadBake(episode.battleBakePath) : null;
  const N = episode.items.length;
  const result = episode.battleResult;

  const battleFrame = result
    ? Math.max(0, Math.min(result.battleFrames - 1, frame - COUNTDOWN_FRAMES))
    : 0;

  return (
    <>
      <color attach="background" args={["#eef3f8"]} />
      <fog attach="fog" args={["#e9eff5", 36, 100]} />
      <Backdrop />
      <StudioEnvironment />
      <ArenaLights />
      <CameraRig episode={episode} bake={bake} numTops={N} />
      <Arena />
      <TopField episode={episode} bake={bake} frame={battleFrame} N={N} />
    </>
  );
};

// Studio HDRI-style environment built from emissive light panels (no external
// files — works in headless render). Gives the chrome tops + metal arena
// something premium to reflect, which is what sells the "modern game" look.
const StudioEnvironment: React.FC = () => {
  return (
    <Environment resolution={128} frames={1}>
      <color attach="background" args={["#e6ebf1"]} />
      {/* Big soft key panel overhead-front */}
      <Lightformer
        intensity={3.0}
        position={[0, 6, 8]}
        scale={[18, 10, 1]}
        color="#fff4e0"
      />
      {/* Cool fill from behind-left */}
      <Lightformer
        intensity={1.2}
        position={[-10, 4, -8]}
        scale={[12, 8, 1]}
        color="#9fb8ff"
      />
      {/* Warm rim from behind-right */}
      <Lightformer
        intensity={1.6}
        position={[10, 3, -6]}
        scale={[10, 6, 1]}
        color="#ffd9a0"
      />
      {/* Thin bright streaks for crisp chrome highlights */}
      <Lightformer intensity={2.5} position={[0, 8, 2]} scale={[1.5, 14, 1]} color="#ffffff" />
      <Lightformer intensity={2.0} position={[-4, 8, 2]} scale={[0.8, 12, 1]} color="#ffffff" />
      <Lightformer intensity={2.0} position={[4, 8, 2]} scale={[0.8, 12, 1]} color="#ffffff" />
    </Environment>
  );
};

const TopField: React.FC<{
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
        t.anisotropy = 8;
      }
    }
  }, [coverTextures]);

  return (
    <>
      {Array.from({ length: N }).map((_, i) => {
        const tex = episode.items[i].imagePath
          ? (Array.isArray(coverTextures) ? coverTextures[i] : coverTextures) ?? null
          : null;
        // Eliminated tops are NOT hidden — they stay on the table as stopped
        // obstacles (their baked position is wherever they came to rest, and
        // live tops keep bumping them). Only the rare fell-through-floor case
        // is culled, handled inside <Top> via the y<-5 guard.
        return (
          <Top
            key={i}
            index={i}
            accent={ACCENT_PALETTE[i % ACCENT_PALETTE.length]}
            texture={tex}
            bake={bake}
            frame={frame}
            numTops={N}
          />
        );
      })}
    </>
  );
};

const ArenaLights: React.FC = () => {
  // Top-down spotlight to mimic a studio shoot — the marble catches a
  // bright highlight directly below the key light, and the polished
  // wooden rim gets a soft secondary from the rim of the spotlight cone.
  return (
    <>
      <hemisphereLight args={["#ffffff", "#cdd5de", 1.0]} />
      {/* Key — strong warm light from above-front for bright tops + highlights */}
      <directionalLight position={[2, 22, 10]} intensity={4.2} color="#fff4e0" />
      {/* Fills */}
      <directionalLight position={[14, 14, 12]} intensity={1.4} color="#fff0d8" />
      <directionalLight position={[-12, 12, -10]} intensity={0.9} color="#a8b8d8" />
      {/* Camera-side low fill — lifts the lower/front of each top so the
          conical underside doesn't read black. */}
      <directionalLight position={[0, 3, 18]} intensity={1.1} color="#dfe6f0" />
      {/* Studio spotlight pool on the arena center — decay 1.5 so it actually
          reaches the floor ~18 units away. */}
      <spotLight
        position={[0, 18, 4]}
        target-position={[0, 0, 0]}
        angle={0.7}
        penumbra={0.7}
        intensity={5000}
        distance={60}
        decay={1.5}
        color="#fff6e6"
      />
    </>
  );
};

// ─── Arena ────────────────────────────────────────────────────
// Wall geometry — inner face aligned with the physics walls (at ±ARENA_HALF)
// in battle-roll.mjs so the visible wall is exactly where tops bounce.
const WALL_VIS_HEIGHT = 0.7;
const WALL_VIS_THICK = 0.45;
const BOARD_DROP = 0.7; // how far the board slab extends down onto the ground
const GROUND_Y = FLOOR_Y - BOARD_DROP;

// Premium studio gradients (built on a canvas — no external files, works in
// headless render). A radial floor glow + a vertical backdrop give the scene
// real depth instead of a flat poster colour.
function makeRadialGradientTexture(inner: string, outer: string): THREE.CanvasTexture {
  const size = 1024;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.04, size / 2, size / 2, size * 0.6);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function makeVerticalGradientTexture(stops: [number, string][]): THREE.CanvasTexture {
  const h = 512;
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  for (const [o, col] of stops) g.addColorStop(o, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 8, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Large vertical-gradient backdrop standing behind the arena (premium studio
// cove). Unlit + fog-exempt so it shows the full rich gradient.
const Backdrop: React.FC = () => {
  const tex = useMemo(
    () =>
      makeVerticalGradientTexture([
        [0, "#d4dde7"],
        [0.6, "#e9eff5"],
        [1, "#f7fafc"],
      ]),
    [],
  );
  return (
    <mesh position={[0, 16, -40]}>
      <planeGeometry args={[280, 150]} />
      <meshBasicMaterial map={tex} toneMapped={false} fog={false} />
    </mesh>
  );
};

const Arena: React.FC = () => {
  const steelTex = useMemo(
    () => makeBrushedSteelTexture({ size: 1024, seed: 0x9c7e1131 }),
    [],
  );
  // Premium floor: a soft radial glow (brighter under the board, deepening out)
  // on a glossy surface so it catches the studio lights — reads real, not flat.
  const floorTex = useMemo(() => makeRadialGradientTexture("#ffffff", "#d3dbe4"), []);

  return (
    <>
      {/* OUTER SURFACE — premium glossy studio floor with a soft radial glow
          (brighter under the board), reflecting the studio lights for depth. */}
      <mesh position={[0, GROUND_Y, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[120, 120]} />
        <meshStandardMaterial
          map={floorTex}
          roughness={0.34}
          metalness={0.0}
          envMapIntensity={1.1}
        />
      </mesh>

      {/* BOARD SLAB — raised platform sitting on the surface. Top face at
          y=0 (matches physics floor); extends down BOARD_DROP onto the
          ground so it reads as a thick board, not a floating sheet. */}
      <mesh position={[0, FLOOR_Y - BOARD_DROP / 2, 0]}>
        <boxGeometry args={[ARENA_HALF_X * 2 + WALL_VIS_THICK * 2 + 0.3, BOARD_DROP, ARENA_HALF_Z * 2 + WALL_VIS_THICK * 2 + 0.3]} />
        <meshStandardMaterial color={"#c4ccd6"} roughness={0.5} metalness={0.5} envMapIntensity={1.0} />
      </mesh>

      {/* PLAY SURFACE — light brushed-steel floor the tops spin on. */}
      <mesh position={[0, FLOOR_Y - 0.02, 0]}>
        <boxGeometry args={[ARENA_HALF_X * 2, 0.06, ARENA_HALF_Z * 2]} />
        <meshStandardMaterial
          map={steelTex}
          color={"#aab3be"}
          roughness={0.3}
          metalness={0.8}
          envMapIntensity={1.8}
        />
      </mesh>

      {/* CONTAINING WALLS — a low rim that keeps tops in and reads as the
          board's edge. Inner face at ±ARENA_HALF (matches physics). */}
      <ArenaWalls />
    </>
  );
};

const ArenaWalls: React.FC = () => {
  const cy = FLOOR_Y + WALL_VIS_HEIGHT / 2;
  const off = WALL_VIS_THICK / 2;
  // Dark brushed gunmetal rim — premium, not cheap white plastic.
  const wallMat = (
    <meshStandardMaterial color={"#d2d9e1"} roughness={0.34} metalness={0.95} envMapIntensity={1.5} />
  );
  return (
    <>
      {/* ±Z long walls (run along X) */}
      {[1, -1].map((s) => (
        <mesh key={`wz${s}`} position={[0, cy, s * (ARENA_HALF_Z + off)]}>
          <boxGeometry args={[ARENA_HALF_X * 2 + WALL_VIS_THICK * 2, WALL_VIS_HEIGHT, WALL_VIS_THICK]} />
          {wallMat}
        </mesh>
      ))}
      {/* ±X short walls (run along Z) */}
      {[1, -1].map((s) => (
        <mesh key={`wx${s}`} position={[s * (ARENA_HALF_X + off), cy, 0]}>
          <boxGeometry args={[WALL_VIS_THICK, WALL_VIS_HEIGHT, ARENA_HALF_Z * 2]} />
          {wallMat}
        </mesh>
      ))}
    </>
  );
};

// ─── Procedural textures ──────────────────────────────────────
// Brushed steel — directional grain lines (horizontal in UV) plus fine
// speckle. Reads as a polished but lined metal surface under the key
// light. Modeled on race-slides.tsx's makeSteelTexture but with
// stronger directional brushing.
function makeBrushedSteelTexture(opts: {
  size: number;
  seed: number;
}): THREE.CanvasTexture {
  const { size: SIZE, seed } = opts;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;

  const rand = mulberry32(seed);
  const highlight = hexToRgb(COLOR_STEEL_HIGHLIGHT);
  const shadow = hexToRgb(COLOR_STEEL_SHADOW);

  ctx.fillStyle = COLOR_STEEL_BASE;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Soft tonal blotches.
  for (let i = 0; i < 18; i++) {
    const cx = rand() * SIZE;
    const cy = rand() * SIZE;
    const r = SIZE * (0.15 + rand() * 0.3);
    const tint = rand() < 0.5 ? highlight : shadow;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `rgba(${tint.r},${tint.g},${tint.b},${0.04 + rand() * 0.07})`);
    grad.addColorStop(1, `rgba(${tint.r},${tint.g},${tint.b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, SIZE, SIZE);
  }

  // Directional brushing — many horizontal hairlines of varying alpha.
  // These give brushed steel its characteristic linear sheen.
  for (let i = 0; i < SIZE * 2.2; i++) {
    const y = rand() * SIZE;
    const lighter = rand() < 0.5;
    const tint = lighter ? highlight : shadow;
    const alpha = 0.04 + rand() * 0.14;
    ctx.strokeStyle = `rgba(${tint.r},${tint.g},${tint.b},${alpha})`;
    ctx.lineWidth = 0.5 + rand() * 0.8;
    // Lines aren't perfectly horizontal — slight wobble so the grain
    // looks hand-brushed, not laser-etched.
    ctx.beginPath();
    let x = 0;
    let yy = y;
    ctx.moveTo(x, yy);
    while (x < SIZE) {
      x += 20 + rand() * 40;
      yy = y + (rand() - 0.5) * 0.6;
      ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }

  // Speckle for surface tooth.
  const speckles = Math.floor((SIZE * SIZE) / 14);
  for (let i = 0; i < speckles; i++) {
    const x = Math.floor(rand() * SIZE);
    const y = Math.floor(rand() * SIZE);
    const lighter = rand() < 0.5;
    const tint = lighter ? highlight : shadow;
    const alpha = 0.06 + rand() * 0.16;
    ctx.fillStyle = `rgba(${tint.r},${tint.g},${tint.b},${alpha})`;
    ctx.fillRect(x, y, 1, 1);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1.2);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Warm matte tabletop — soft wood-grain-ish streaks + grain so the outer
// surface reads as a real desk the board sits on (not a flat void).
function makeSurfaceTexture(opts: { size: number; seed: number }): THREE.CanvasTexture {
  const { size: SIZE, seed } = opts;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  const rand = mulberry32(seed);

  ctx.fillStyle = "#4a3a2a";
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Broad tonal bands (plank-ish variation).
  for (let i = 0; i < 26; i++) {
    const y = rand() * SIZE;
    const h = SIZE * (0.02 + rand() * 0.06);
    const dark = rand() < 0.5;
    ctx.fillStyle = dark
      ? `rgba(30,22,14,${0.06 + rand() * 0.1})`
      : `rgba(120,95,66,${0.05 + rand() * 0.1})`;
    ctx.fillRect(0, y, SIZE, h);
  }
  // Fine horizontal grain lines.
  for (let i = 0; i < SIZE * 1.5; i++) {
    const y = rand() * SIZE;
    const dark = rand() < 0.5;
    ctx.strokeStyle = dark
      ? `rgba(25,18,10,${0.04 + rand() * 0.08})`
      : `rgba(130,105,72,${0.03 + rand() * 0.07})`;
    ctx.lineWidth = 0.5 + rand() * 1.0;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(SIZE, y + (rand() - 0.5) * 2);
    ctx.stroke();
  }
  // Speckle.
  const speckles = Math.floor((SIZE * SIZE) / 20);
  for (let i = 0; i < speckles; i++) {
    const x = Math.floor(rand() * SIZE);
    const y = Math.floor(rand() * SIZE);
    const a = 0.04 + rand() * 0.1;
    ctx.fillStyle = rand() < 0.5 ? `rgba(20,14,8,${a})` : `rgba(140,112,78,${a})`;
    ctx.fillRect(x, y, 1, 1);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Soft round contact-shadow blob (radial gradient, transparent edges) painted
// on the floor under each top so they read as grounded, not floating.
let _shadowTexSingleton: THREE.CanvasTexture | null = null;
function getShadowTexture(): THREE.CanvasTexture {
  if (_shadowTexSingleton) return _shadowTexSingleton;
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, "rgba(0,0,0,0.55)");
  g.addColorStop(0.55, "rgba(0,0,0,0.28)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  _shadowTexSingleton = new THREE.CanvasTexture(canvas);
  return _shadowTexSingleton;
}


// ─── Spinning top ──────────────────────────────────────────────
const Top: React.FC<{
  index: number;
  accent: string;
  texture: THREE.Texture | null;
  bake: Float32Array | null;
  frame: number;
  numTops: number;
}> = ({ index, accent, texture, bake, frame, numTops }) => {
  let x = 0,
    y = TOP_HEIGHT / 2,
    z = 0;
  let qx = 0,
    qy = 0,
    qz = 0,
    qw = 1;
  let energy = 1;
  if (bake) {
    const t = readTop(bake, frame, index, numTops);
    x = t.x;
    y = t.y;
    z = t.z;
    qx = t.qx;
    qy = t.qy;
    qz = t.qz;
    qw = t.qw;
    energy = t.energy;
  } else {
    // Pre-bake fallback layout — a small ring at the arena center so
    // the studio thumbnail renders with the tops in roughly sensible
    // positions. Real positions come from the bake once it loads.
    const theta = (index / numTops) * Math.PI * 2;
    x = Math.cos(theta) * 2.0;
    z = Math.sin(theta) * 2.0;
  }

  // Safety: a top that somehow fell through the floor isn't rendered.
  if (y < -5) return null;

  // The physics quaternion drives everything: a live top spins (Y rotation
  // changes each frame); a stopped top sits upright and still. No artificial
  // wobble — stopped tops simply rest in place as obstacles.
  const composedQuat = useMemo(
    () => new THREE.Quaternion(qx, qy, qz, qw),
    [qx, qy, qz, qw],
  );

  // Visual top = a lathed chrome body (classic spinning-top silhouette:
  // pointed tip → wide disc → flag face), a thin accent ring at the rim for
  // per-top identity, the flag disc on the flat top, and a small gold stem
  // knob. The collider stays a plain cylinder (physics only) — the visual is
  // free to be this nicer shape.
  const shellGeo = useTopShellGeometry();
  const shadowTex = getShadowTexture();
  // Spin blur: while a top still has spin, overlay a couple of faint flag
  // copies at trailing angles so it reads as fast-spinning motion (the flag
  // smears into a ring) rather than a frozen disc.
  // Spin-blur stays on until a top is nearly dead (not 0.22) so a collision
  // that bleeds spin doesn't make a still-spinning top look frozen. The smear
  // arc + opacity scale with energy, so a fast top reads visibly faster than a
  // slow one (raw rotation alone aliases at 30fps and can't show speed).
  const spinning = energy > 0.05;
  const blurArc = 1.0 + energy * 2.6;   // wider trailing smear when faster
  const blurOpacity = Math.min(1, energy * 1.5);
  return (
    <>
      {/* Contact shadow on the floor (kept flat, follows x/z only). */}
      <mesh position={[x, 0.03, z]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[TOP_RADIUS * 2.6, TOP_RADIUS * 2.6]} />
        <meshBasicMaterial map={shadowTex} transparent depthWrite={false} opacity={0.9} />
      </mesh>

      <group position={[x, y, z]}>
        <group quaternion={composedQuat}>
          {/* Satin metal lathed body — reads as a clear 3D cone with an even
              light tone top-to-bottom (small self-color emissive lifts the tip). */}
          <mesh geometry={shellGeo}>
            <meshStandardMaterial
              color={"#aab0b8"}
              roughness={0.3}
              metalness={0.9}
              envMapIntensity={1.5}
              emissive={"#5a6068"}
              emissiveIntensity={0.12}
            />
          </mesh>

          {/* Polished colored-metal accent ring at the rim. */}
          <mesh position={[0, TOP_DISC_Y - 0.02, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[TOP_RADIUS * 0.92, TOP_HEIGHT * 0.055, 14, 72]} />
            <meshStandardMaterial color={accent} roughness={0.22} metalness={0.9} envMapIntensity={1.4} />
          </mesh>

          {/* Flat flag disc — unlit + non-tonemapped so it stays vivid. */}
          <mesh position={[0, TOP_DISC_Y + 0.02, 0]}>
            <cylinderGeometry args={[TOP_RADIUS * 0.8, TOP_RADIUS * 0.8, 0.06, 64]} />
            {texture ? (
              <meshBasicMaterial map={texture} toneMapped={false} />
            ) : (
              <meshBasicMaterial color={accent} toneMapped={false} />
            )}
          </mesh>

          {/* Spin-blur ghosts — a fan of trailing flag copies whose arc and
              opacity grow with energy, so the smear reads as real fast-spin
              motion and stays present until the top is nearly stopped. The
              sharp flag above stays readable (country still identifiable). */}
          {spinning && texture && [0, 1, 2, 3, 4, 5].map((k) => {
            const frac = (k + 1) / 6;
            return (
              <mesh
                key={k}
                position={[0, TOP_DISC_Y + 0.021 + k * 0.001, 0]}
                rotation={[0, -frac * blurArc, 0]}
              >
                <cylinderGeometry args={[TOP_RADIUS * 0.8, TOP_RADIUS * 0.8, 0.06, 64]} />
                <meshBasicMaterial
                  map={texture}
                  toneMapped={false}
                  transparent
                  opacity={(0.34 - frac * 0.04) * blurOpacity}
                  depthWrite={false}
                />
              </mesh>
            );
          })}

          {/* Gold stem knob at center top. */}
          <mesh position={[0, TOP_DISC_Y + 0.13, 0]}>
            <cylinderGeometry args={[TOP_RADIUS * 0.1, TOP_RADIUS * 0.12, 0.22, 24]} />
            <meshStandardMaterial color={"#e6b54a"} roughness={0.22} metalness={1.0} />
          </mesh>
          <mesh position={[0, TOP_DISC_Y + 0.25, 0]}>
            <sphereGeometry args={[TOP_RADIUS * 0.11, 20, 16]} />
            <meshStandardMaterial color={"#e6b54a"} roughness={0.22} metalness={1.0} />
          </mesh>
        </group>
      </group>
    </>
  );
};

// Vertical layout (local Y). The point sits at the collider bottom
// (-TOP_HEIGHT/2) so it rests on the floor; the disc/flag sit higher up so the
// body is a tall, clearly-3D cone rather than a flat coin.
const POINT_Y = -TOP_HEIGHT * 0.5;     // floor contact (matches physics)
const TOP_DISC_Y = 0.44;               // disc / flag / accent plane

// Shared lathed shell geometry for every top (one allocation, reused).
let _shellGeoSingleton: THREE.LatheGeometry | null = null;
function useTopShellGeometry(): THREE.LatheGeometry {
  return useMemo(() => {
    if (_shellGeoSingleton) return _shellGeoSingleton;
    const R = TOP_RADIUS;
    // (radius, y): a squat, FAT body (like a real wooden top) — widens quickly
    // from the floor point to the broad disc, so it reads as one solid mass,
    // not a thin stemmed glass.
    const pts: THREE.Vector2[] = [
      new THREE.Vector2(0.0, POINT_Y),
      new THREE.Vector2(0.34 * R, POINT_Y + 0.14),
      new THREE.Vector2(0.62 * R, POINT_Y + 0.32),
      new THREE.Vector2(0.86 * R, POINT_Y + 0.52),
      new THREE.Vector2(R, TOP_DISC_Y - 0.14),    // approaching widest
      new THREE.Vector2(R, TOP_DISC_Y - 0.03),    // crisp vertical rim
      new THREE.Vector2(R * 0.82, TOP_DISC_Y + 0.02),
      new THREE.Vector2(0.0, TOP_DISC_Y + 0.02),  // flat cap
    ];
    _shellGeoSingleton = new THREE.LatheGeometry(pts, 72);
    _shellGeoSingleton.computeVertexNormals();
    return _shellGeoSingleton;
  }, []);
}

// ─── Camera ────────────────────────────────────────────────────
const CameraRig: React.FC<{
  episode: Episode;
  bake: Float32Array | null;
  numTops: number;
}> = ({ episode, bake, numTops }) => {
  const frame = useCurrentFrame();
  const { camera } = useThree();
  const result = episode.battleResult;
  const battleFrames = result?.battleFrames ?? 0;

  // Note: no per-frame battle position read — tops are stationary after
  // the initial collision phase, so the battle-body camera is fixed and
  // doesn't need to track a centroid.

  const inCountdown = frame < COUNTDOWN_FRAMES;
  const inPodium = result != null && frame >= COUNTDOWN_FRAMES + battleFrames;
  const winnerIdx = result?.survivorOrder[0] ?? 0;

  let pos: [number, number, number];
  let look: [number, number, number];
  let fov = 50;
  // The "up" vector matters for the near-top-down view — we want world
  // +X to be the screen's horizontal axis (long side of the arena
  // along the screen's long side). Setting camera.up = (0,0,-1) makes
  // world -Z appear at the top of the screen, so the rectangle reads
  // landscape-oriented (20 wide × 11.25 tall in screen space).
  // Cinematic 3/4 view (normal Y-up) for countdown + battle so the tops
  // read as 3D objects, not flat discs. Only the podium uses its own up.
  const useTopDownUp = false;

  if (inCountdown) {
    // Slow push-in. Far + telephoto so perspective is compressed and every
    // top reads a similar size regardless of depth.
    const t = Easing.inOut(Easing.ease)(frame / COUNTDOWN_FRAMES);
    pos = [0, lerp(19, 17.5, t), lerp(26, 24, t)];
    look = [0, 0.3, 0];
    fov = lerp(25, 24, t);
  } else if (inPodium && bake) {
    // Hero hold on the champion — continues smoothly from where the in-battle
    // victory zoom ended, with a gentle orbit/push.
    const w = readTop(bake, battleFrames - 1, winnerIdx, numTops);
    const t = Math.min(1, (frame - COUNTDOWN_FRAMES - battleFrames) / PODIUM_FRAMES);
    const orbit = t * 0.5;
    const rad = lerp(5.0, 4.2, t);
    pos = [w.x + Math.sin(orbit) * 1.5, lerp(4.0, 3.2, t), w.z + Math.cos(orbit) * rad];
    look = [w.x, 0.5, w.z];
    fov = 30;
  } else {
    // Battle body — far + telephoto 3/4 view that frames the whole arena with
    // even top sizes. For the final VICTORY_HOLD beat (lone winner spinning),
    // smoothly ZOOM in on the champion so the reveal feels earned, not abrupt.
    const t = frame / 60;
    const widePos: [number, number, number] = [
      Math.sin(t * 0.22) * 1.0,
      17.5 + Math.sin(t * 0.16) * 0.4,
      24 + Math.cos(t * 0.19) * 0.8,
    ];
    const wideLook: [number, number, number] = [Math.sin(t * 0.13) * 0.4, 0.2, 0];
    const wideFov = 24 + Math.sin(t * 0.1) * 0.4;

    const battleLocal = frame - COUNTDOWN_FRAMES;
    const victoryStart = battleFrames - VICTORY_HOLD;
    if (bake && battleFrames > 0 && battleLocal >= victoryStart) {
      const w = readTop(bake, Math.min(battleFrames - 1, battleLocal), winnerIdx, numTops);
      const zt = Easing.inOut(Easing.ease)(
        Math.min(1, (battleLocal - victoryStart) / VICTORY_HOLD),
      );
      const closePos: [number, number, number] = [w.x, 4.0, w.z + 5.0];
      const closeLook: [number, number, number] = [w.x, 0.6, w.z];
      pos = [
        lerp(widePos[0], closePos[0], zt),
        lerp(widePos[1], closePos[1], zt),
        lerp(widePos[2], closePos[2], zt),
      ];
      look = [
        lerp(wideLook[0], closeLook[0], zt),
        lerp(wideLook[1], closeLook[1], zt),
        lerp(wideLook[2], closeLook[2], zt),
      ];
      fov = lerp(wideFov, 30, zt);
    } else {
      pos = widePos;
      look = wideLook;
      fov = wideFov;
    }
  }

  if (useTopDownUp) {
    camera.up.set(0, 0, -1);
  } else {
    camera.up.set(0, 1, 0);
  }
  camera.position.set(pos[0], pos[1], pos[2]);
  camera.lookAt(look[0], look[1], look[2]);
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
  return null;
};

// ─── HUD ───────────────────────────────────────────────────────
const HUD: React.FC<{ episode: Episode }> = ({ episode }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const result = episode.battleResult;

  const countdownActive = frame < COUNTDOWN_FRAMES;
  const secondsLeft = Math.ceil((COUNTDOWN_FRAMES - frame) / fps);
  const goLabel = frame < COUNTDOWN_FRAMES - fps * 0.2 ? `${secondsLeft}` : "GO!";

  const battleFrame = Math.max(0, frame - COUNTDOWN_FRAMES);

  const winnerIdx = result?.survivorOrder[0];
  const battleFramesTotal = result?.battleFrames ?? 0;
  // Reveal as the victory zoom completes — i.e. near the END of the battle body
  // (after the lone winner has spun alone for a beat), then hold through the
  // podium. Not the instant the runner-up stops.
  const revealStart = battleFramesTotal - fps * 0.55;
  const winnerVisible =
    result != null && winnerIdx != null && battleFrame >= revealStart;
  const winnerOpacity = winnerVisible
    ? Math.min(1, (battleFrame - revealStart) / (fps * 0.5))
    : 0;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {/* Title during countdown only — single line, title-case, medium weight. */}
      {countdownActive && (
        <div
          style={{
            position: "absolute",
            top: 64,
            left: 0,
            right: 0,
            textAlign: "center",
            color: "#17202e",
            textShadow: "0 2px 12px rgba(255,255,255,0.6)",
            opacity: interpolate(frame, [0, 20], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          <div
            style={{
              fontSize: 60,
              fontWeight: 500,
              letterSpacing: 1,
              textTransform: "capitalize",
            }}
          >
            {(episode.title[1] ?? "").toLowerCase()}
          </div>
        </div>
      )}

      {countdownActive && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: 0,
            right: 0,
            transform: "translateY(-50%)",
            textAlign: "center",
            color: "#0a9d4e",
            fontSize: 300,
            fontWeight: 700,
            letterSpacing: -8,
            textShadow: "0 4px 24px rgba(255,255,255,0.7)",
            opacity: countdownPulseOpacity(frame, fps),
          }}
        >
          {goLabel}
        </div>
      )}

      {/* Leaderboard intentionally removed — showing live standings lets
          viewers predict the outcome, which kills engagement. */}

      {winnerOpacity > 0 && winnerIdx != null && (
        <div
          style={{
            position: "absolute",
            bottom: 96,
            left: 0,
            right: 0,
            textAlign: "center",
            color: "#17202e",
            opacity: winnerOpacity,
            textShadow: "0 2px 16px rgba(255,255,255,0.7)",
          }}
        >
          <div
            style={{
              fontSize: 26,
              letterSpacing: 4,
              opacity: 1,
              textTransform: "capitalize",
              fontWeight: 500,
            }}
          >
            last top spinning
          </div>
          <div style={{ fontSize: 80, fontWeight: 600, color: "#0a9d4e", marginTop: 6 }}>
            {episode.items[winnerIdx].title}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};

// ─── Helpers ───────────────────────
function hexToRgb(hex: string) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
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

function countdownPulseOpacity(frame: number, fps: number): number {
  const phaseFrame = frame % fps;
  if (phaseFrame < fps * 0.2)
    return interpolate(phaseFrame, [0, fps * 0.2], [0, 1]);
  if (phaseFrame > fps * 0.8)
    return interpolate(phaseFrame, [fps * 0.8, fps], [1, 0]);
  return 1;
}
