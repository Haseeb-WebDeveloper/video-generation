import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import { useMemo, Suspense } from "react";
import {
  AbsoluteFill,
  Easing,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { games, Game } from "./games";

// ───── Geometry ─────
const SPACING = 7.4;
const PLINTH_W = 4.2;
const PLINTH_D = 4.2;
const HEIGHT_SCALE = 1 / 10;
const MIN_HEIGHT = 3;
const COVER_W = 4.0;
const COVER_H = 6.0;
const CAP_H = 0.18;
const FOV = 36;

// ───── Palette ─────
// Warm cream plinth against navy hall — gallery contrast without harshness.
const PLINTH_COLOR = "#e8e2d0";
const CAP_COLOR = "#d4cdb8";
const FLOOR_COLOR = "#1a2740";
const TEXT_DARK = "#1a2236";
const ACCENT = "#3d7ec2";

const COVERS: Record<number, string> = {
  1: "1.png",
  2: "2.jpg",
  3: "3.png",
  4: "4.jpg",
  5: "5.jpg",
  6: "6.jpg",
  7: "7.jpg",
  8: "8.jpg",
  9: "9.jpg",
  10: "10.png",
  11: "11.jpg",
  12: "12.png",
  13: "13.jpg",
  14: "14.jpg",
  15: "15.jpg",
  16: "16.png",
  17: "17.jpg",
  18: "18.png",
  19: "19.jpg",
  20: "20.jpg",
};

const ordered = [...games].sort((a, b) => b.rank - a.rank);
const xForIndex = (i: number) =>
  i * SPACING - ((ordered.length - 1) * SPACING) / 2;
const heightFor = (g: Game) =>
  Math.max(MIN_HEIGHT, g.copiesMillions * HEIGHT_SCALE);

function formatValue(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)}B`;
  return `${m}M`;
}

type Vec3 = [number, number, number];

// ───── Decal plaque dimensions (referenced by camera + plinth) ─────
const DECAL_PLANE_W = PLINTH_W * 0.82;
const DECAL_PLANE_H = 1.7;
const DECAL_W = 1024;
const DECAL_H = Math.round((DECAL_W * DECAL_PLANE_H) / DECAL_PLANE_W);

// ───── Camera framing ─────
// Fixed close distance + low eye level. The lookAt point follows the cover,
// so tall plinths cause the camera to angle UP — bottom of the plinth drops
// out of frame, cover stays centered. This is what sells "real camera looking
// up at a towering monument."
const FOV_HALF_TAN = Math.tan((FOV * Math.PI) / 180 / 2);
const FIXED_DIST = 24;
const EYE_Y = 5;
const SIDE_OFFSET_X = 1.6;

const coverCenterY = (h: number) => h + CAP_H + COVER_H / 2;

// Per-plinth focus point. The camera passes through these as a single
// continuous spline. Camera Y rises smoothly from low (short plinths → looking
// up) all the way to FULL eye-level with the cover for tall plinths. By #1
// the camera and the cover are at the same Y → completely level, head-on
// shot. No upward tilt at the climax.
//
// camY targets EYE_Y for h ≤ ~5, smoothly approaches cover center for h ≥ ~13.
const camYForHeight = (h: number): number => {
  const cY = coverCenterY(h);
  const t = Math.min(1, Math.max(0, (h - 4) / 9));
  return EYE_Y + (cY - EYE_Y) * t;
};

type FocusPoint = { camPos: Vec3; lookAt: Vec3 };

const focusPoints: FocusPoint[] = ordered.map((g, i) => {
  const x = xForIndex(i);
  const h = heightFor(g);
  const cY = coverCenterY(h);
  return {
    camPos: [x + SIDE_OFFSET_X, camYForHeight(h), FIXED_DIST],
    lookAt: [x, cY, 0],
  };
});

const N = focusPoints.length;

const startPose: FocusPoint = {
  camPos: [xForIndex(0) - 12, EYE_Y + 1, FIXED_DIST + 6],
  lookAt: [xForIndex(0) + 2, EYE_Y + 1, 0],
};

// Outro: small symmetric pull-back from the hero. Camera stays at the SAME
// Y as the cover (no dipping), only Z increases slightly. Focus stays on #1
// — no reveal of other plinths, no dramatic angle change.
const outroPose: FocusPoint = (() => {
  const x = xForIndex(N - 1);
  const h = heightFor(ordered[N - 1]);
  const cY = coverCenterY(h);
  return {
    camPos: [x + SIDE_OFFSET_X, cY, FIXED_DIST + 14],
    lookAt: [x, cY, 0],
  };
})();

// ───── Pacing (60fps) — single continuous shot, no per-plinth holds ─────
const PHASE_INTRO = 90; // 1.5s — opening dolly into first plinth
const PHASE_TRAVEL = 2100; // 35s — full sweep, weighted per plinth
const PHASE_HERO = 180; // 3.0s — hold on #1 cover at the climax
const PHASE_OUTRO = 150; // 2.5s — small pull-back from #1

export const TOTAL_FRAMES =
  PHASE_INTRO + PHASE_TRAVEL + PHASE_HERO + PHASE_OUTRO + 30;

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

// Easings
const easeInOut = Easing.bezier(0.45, 0, 0.2, 1);
// Travel uses LINEAR progress — the per-plinth weights below handle pacing.
// (An eased curve would compress the middle plinths, making them blur past.)
const easeTravel = (t: number) => t;

// Per-plinth time weights. Each plinth gets its own slice of PHASE_TRAVEL,
// proportional to its weight. Tall plinths get more time for the cinematic
// climax; weights are otherwise close to uniform so speed feels constant.
const plinthWeights: number[] = ordered.map((g) => {
  const h = heightFor(g);
  // Smooth boost as height grows. Short plinths weight ~1.0; hero ~1.7.
  const heightBoost = Math.min(0.7, Math.max(0, (h - 4) / 28));
  return 1.0 + heightBoost;
});
const cumWeights: number[] = [0];
for (let i = 0; i < plinthWeights.length; i++) {
  cumWeights.push(cumWeights[i] + plinthWeights[i]);
}
const totalWeight = cumWeights[cumWeights.length - 1];

// Map progress p ∈ [0, 1] to a float plinth index, allocating each plinth
// a slice of the timeline proportional to its weight.
function progressToFloatIdx(p: number): number {
  const target = p * totalWeight;
  for (let i = 0; i < plinthWeights.length; i++) {
    if (cumWeights[i + 1] >= target) {
      const segStart = cumWeights[i];
      const segEnd = cumWeights[i + 1];
      const f = (target - segStart) / (segEnd - segStart);
      return i + f;
    }
  }
  return plinthWeights.length - 1;
}

function CameraRig() {
  const frame = useCurrentFrame();
  const camera = useThree((s) => s.camera);

  let pos: Vec3;
  let look: Vec3;

  if (frame < PHASE_INTRO) {
    // Opening dolly: startPose → focusPoints[0]
    const t = frame / PHASE_INTRO;
    const eased = easeInOut(t);
    pos = lerpVec3(startPose.camPos, focusPoints[0].camPos, eased);
    look = lerpVec3(startPose.lookAt, focusPoints[0].lookAt, eased);
  } else if (frame < PHASE_INTRO + PHASE_TRAVEL) {
    // Continuous weighted spline through all plinths' focus points
    const tNorm = (frame - PHASE_INTRO) / PHASE_TRAVEL;
    const eased = easeTravel(tNorm);
    const floatIdx = progressToFloatIdx(eased);
    const a = Math.min(Math.floor(floatIdx), N - 2);
    const b = a + 1;
    const f = floatIdx - a;
    const ff = f * f * (3 - 2 * f);
    pos = lerpVec3(focusPoints[a].camPos, focusPoints[b].camPos, ff);
    look = lerpVec3(focusPoints[a].lookAt, focusPoints[b].lookAt, ff);
  } else if (frame < PHASE_INTRO + PHASE_TRAVEL + PHASE_HERO) {
    // Hold on #1 — settle at the hero
    pos = focusPoints[N - 1].camPos;
    look = focusPoints[N - 1].lookAt;
  } else {
    // Outro pull-back: focusPoints[#1] → outroPose
    const t = Math.min(
      1,
      (frame - PHASE_INTRO - PHASE_TRAVEL - PHASE_HERO) / PHASE_OUTRO,
    );
    const eased = easeInOut(t);
    pos = lerpVec3(focusPoints[N - 1].camPos, outroPose.camPos, eased);
    look = lerpVec3(focusPoints[N - 1].lookAt, outroPose.lookAt, eased);
  }

  // Subtle handheld drift — sells "real camera" feel without stops
  const time = frame / 60;
  const driftX = Math.sin(time * 0.7) * 0.06;
  const driftY = Math.cos(time * 0.55) * 0.05;
  const driftZ = Math.sin(time * 0.45) * 0.04;

  camera.position.set(pos[0] + driftX, pos[1] + driftY, pos[2] + driftZ);
  camera.lookAt(look[0], look[1], look[2]);
  camera.updateProjectionMatrix();
  return null;
}

function makeFrontDecal(game: Game): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = DECAL_W;
  c.height = DECAL_H;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, DECAL_W, DECAL_H);

  const W = DECAL_W;
  const H = DECAL_H;
  const FONT_FAMILY =
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  // Layout: three centered lines — rank header / name / value
  // No background plate, no chip, no underline. Clean editorial typography.
  const padX = W * 0.06;
  const usableW = W - padX * 2;

  // Sizes — generous (per user request "increase font size")
  const rankSize = Math.round(H * 0.16);
  const nameMaxSize = Math.round(H * 0.22);
  const valueSize = Math.round(H * 0.42);

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  // Fit name to width, allow 1-2 lines
  const nameLines = wrapText(ctx, game.title, usableW, nameMaxSize, 600);
  const actualNameSize = nameLines[0].size;
  const nameLineH = actualNameSize * 1.1;

  const gap1 = H * 0.025; // between rank and name
  const gap2 = H * 0.03; // between name and value

  const blockH =
    rankSize + gap1 + nameLines.length * nameLineH + gap2 + valueSize;
  const topY = (H - blockH) / 2;

  // ── Rank header — letter-spaced uppercase, accent color, light weight
  const rankY = topY + rankSize;
  ctx.fillStyle = ACCENT;
  ctx.font = `700 ${rankSize}px ${FONT_FAMILY}`;
  // Manual letter-spacing for the rank label
  drawSpaced(ctx, `RANK ${game.rank}`, W / 2, rankY, rankSize * 0.18);

  // ── Name — semibold (not heavy black)
  ctx.fillStyle = TEXT_DARK;
  ctx.font = `600 ${actualNameSize}px ${FONT_FAMILY}`;
  const nameStartY = rankY + gap1 + actualNameSize;
  for (let i = 0; i < nameLines.length; i++) {
    ctx.fillText(nameLines[i].text, W / 2, nameStartY + i * nameLineH);
  }

  // ── Value — bold, dominant
  ctx.font = `700 ${valueSize}px ${FONT_FAMILY}`;
  ctx.fillStyle = TEXT_DARK;
  const valueY =
    nameStartY + (nameLines.length - 1) * nameLineH + gap2 + valueSize;
  ctx.fillText(formatValue(game.copiesMillions), W / 2, valueY);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Render text with manual letter-spacing (tracking)
function drawSpaced(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  spacing: number,
) {
  const widths = [...text].map((ch) => ctx.measureText(ch).width);
  const totalW =
    widths.reduce((a, b) => a + b, 0) + spacing * (text.length - 1);
  let x = cx - totalW / 2;
  for (let i = 0; i < text.length; i++) {
    ctx.fillText(text[i], x + widths[i] / 2, y);
    x += widths[i] + spacing;
  }
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  baseSize: number,
  weight: number,
): { text: string; size: number }[] {
  for (let size = baseSize; size >= baseSize * 0.55; size -= 4) {
    ctx.font = `${weight} ${size}px 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) {
      return [{ text, size }];
    }
    const words = text.split(" ");
    for (let split = 1; split < words.length; split++) {
      const l1 = words.slice(0, split).join(" ");
      const l2 = words.slice(split).join(" ");
      if (
        ctx.measureText(l1).width <= maxWidth &&
        ctx.measureText(l2).width <= maxWidth
      ) {
        return [
          { text: l1, size },
          { text: l2, size },
        ];
      }
    }
  }
  return [{ text, size: baseSize * 0.55 }];
}

function makeGridTexture(): THREE.CanvasTexture {
  const S = 1024;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d")!;

  ctx.fillStyle = FLOOR_COLOR;
  ctx.fillRect(0, 0, S, S);

  const cells = 4;
  const cell = S / cells;
  // Major grid — soft, low-contrast so it reads as ambient texture
  ctx.strokeStyle = "rgba(110, 150, 200, 0.18)";
  ctx.lineWidth = 2;
  for (let i = 0; i <= cells; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cell, 0);
    ctx.lineTo(i * cell, S);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * cell);
    ctx.lineTo(S, i * cell);
    ctx.stroke();
  }
  // Minor grid — barely-there
  ctx.strokeStyle = "rgba(90, 130, 180, 0.06)";
  ctx.lineWidth = 1;
  const minorPerCell = 4;
  const minor = cell / minorPerCell;
  for (let i = 0; i < cells * minorPerCell; i++) {
    if (i % minorPerCell === 0) continue;
    ctx.beginPath();
    ctx.moveTo(i * minor, 0);
    ctx.lineTo(i * minor, S);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * minor);
    ctx.lineTo(S, i * minor);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  return tex;
}

function Plinth({
  game,
  index,
  decalTex,
  coverTex,
}: {
  game: Game;
  index: number;
  decalTex: THREE.Texture;
  coverTex: THREE.Texture;
}) {
  const x = xForIndex(index);
  const h = heightFor(game);
  const coverY = h + CAP_H + COVER_H / 2;

  return (
    <group position={[x, 0, 0]}>
      {/* Plinth body */}
      <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[PLINTH_W, h, PLINTH_D]} />
        <meshStandardMaterial
          color={PLINTH_COLOR}
          roughness={0.6}
          metalness={0.05}
        />
      </mesh>

      {/* Decal — wide plaque painted on plinth front, anchored near the top
          so it's always within the camera's framing of the cover area. */}
      <mesh
        position={[0, h - DECAL_PLANE_H / 2 - 0.3, PLINTH_D / 2 + 0.005]}
      >
        <planeGeometry args={[DECAL_PLANE_W, DECAL_PLANE_H]} />
        <meshStandardMaterial
          map={decalTex}
          transparent
          roughness={0.6}
          metalness={0}
          depthWrite={false}
        />
      </mesh>

      {/* Cap */}
      <mesh position={[0, h + CAP_H / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[PLINTH_W + 0.18, CAP_H, PLINTH_D + 0.18]} />
        <meshStandardMaterial
          color={CAP_COLOR}
          roughness={0.45}
          metalness={0.15}
        />
      </mesh>

      {/* Cover — backing for thickness */}
      <mesh position={[0, coverY, 0]} castShadow receiveShadow>
        <boxGeometry args={[COVER_W + 0.12, COVER_H + 0.12, 0.1]} />
        <meshStandardMaterial color="#0d1118" roughness={0.6} metalness={0.1} />
      </mesh>
      <mesh position={[0, coverY, 0.06]}>
        <planeGeometry args={[COVER_W, COVER_H]} />
        <meshStandardMaterial
          map={coverTex}
          roughness={0.45}
          metalness={0}
          side={THREE.FrontSide}
        />
      </mesh>
      <mesh position={[0, coverY, -0.06]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[COVER_W, COVER_H]} />
        <meshStandardMaterial color="#1a1a22" roughness={0.7} />
      </mesh>
    </group>
  );
}

function Hall() {
  const floorGrid = useMemo(() => {
    const t = makeGridTexture();
    t.repeat.set(80, 80);
    return t;
  }, []);
  // Back wall uses the SAME grid texture as the floor (independent instance
  // for its own repeat setting) so the room reads as a single environment.
  const wallGrid = useMemo(() => {
    const t = makeGridTexture();
    t.repeat.set(40, 12); // wider tiling for the wall
    return t;
  }, []);

  return (
    <group>
      {/* Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[1200, 1200]} />
        <meshStandardMaterial
          map={floorGrid}
          color="#ffffff"
          roughness={0.7}
          metalness={0.05}
        />
      </mesh>

      {/* Back wall — same grid style as floor */}
      <mesh position={[0, 100, -180]}>
        <planeGeometry args={[1200, 320]} />
        <meshStandardMaterial
          map={wallGrid}
          color="#ffffff"
          roughness={0.85}
          metalness={0.0}
        />
      </mesh>

      {/* Side walls — solid floor tone, kept simple */}
      <mesh position={[-280, 100, -60]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[400, 320]} />
        <meshStandardMaterial color={FLOOR_COLOR} roughness={0.9} />
      </mesh>
      <mesh position={[280, 100, -60]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[400, 320]} />
        <meshStandardMaterial color={FLOOR_COLOR} roughness={0.9} />
      </mesh>
    </group>
  );
}

function PlinthRow() {
  const coverPaths = useMemo(
    () => ordered.map((g) => staticFile(`covers/${COVERS[g.rank]}`)),
    [],
  );
  const covers = useTexture(coverPaths);
  const decals = useMemo(
    () => ordered.map((g) => makeFrontDecal(g)),
    [],
  );

  useMemo(() => {
    covers.forEach((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 16;
    });
  }, [covers]);

  return (
    <>
      {ordered.map((g, i) => (
        <Plinth
          key={g.rank}
          game={g}
          index={i}
          decalTex={decals[i]}
          coverTex={covers[i]}
        />
      ))}
    </>
  );
}

function Scene() {
  return (
    <>
      <color attach="background" args={["#1d2c47"]} />
      <fog attach="fog" args={["#1d2c47", 120, 320]} />

      <ambientLight intensity={0.85} color="#cfdcef" />

      <directionalLight
        position={[-25, 90, 35]}
        intensity={1.7}
        color="#ffffff"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-120}
        shadow-camera-right={120}
        shadow-camera-top={120}
        shadow-camera-bottom={-120}
        shadow-camera-near={0.1}
        shadow-camera-far={300}
        shadow-bias={-0.0005}
      />

      <directionalLight
        position={[40, 35, 25]}
        intensity={0.55}
        color="#ffd6a8"
      />

      <directionalLight
        position={[0, 30, -50]}
        intensity={0.6}
        color="#7eb5f0"
      />

      <Hall />
      <Suspense fallback={null}>
        <PlinthRow />
      </Suspense>
    </>
  );
}

export const MyComposition = () => {
  const { width, height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: "#1d2c47" }}>
      <ThreeCanvas
        width={width}
        height={height}
        camera={{ fov: FOV, near: 0.1, far: 1500 }}
        shadows
        gl={{
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.15,
          antialias: true,
        }}
      >
        <Suspense fallback={null}>
          <Scene />
        </Suspense>
        <CameraRig />
      </ThreeCanvas>
    </AbsoluteFill>
  );
};
