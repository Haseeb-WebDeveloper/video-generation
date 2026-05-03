import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { Stars, useTexture } from "@react-three/drei";
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

// ───── Sci-fi space hall of fame ─────
// Floating game covers in deep space. No floor, no walls. Cover SIZE encodes
// value (sqrt scale). Holographic frames + cyan text labels. Camera dollies
// across the constellation with slight parallax.

const COVER_ASPECT = 2 / 3; // covers are 2:3 aspect (600×900-ish)
const MAX_COVER_W = 9;
const MIN_COVER_W = 1.6;
const SPACING_GAP = 1.6; // multiplier on item width for cumulative spacing
const FOV = 32;

const BG_COLOR = "#03060e"; // near-black with very faint blue
const NEBULA_TOP = "#0a1428";
const NEBULA_MID = "#1a2244";
const NEBULA_BOT = "#04060e";
const HOLO_CYAN = "#7fd6ff";
const HOLO_DEEP = "#3aa3d8";

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

const ordered = [...games].sort((a, b) => b.rank - a.rank); // #20 left → #1 right
const N = ordered.length;
const maxValue = Math.max(...games.map((g) => g.copiesMillions));

function coverSizeFor(m: number): { w: number; h: number } {
  const t = Math.sqrt(m / maxValue);
  const w = MIN_COVER_W + (MAX_COVER_W - MIN_COVER_W) * t;
  return { w, h: w / COVER_ASPECT };
}

const sizes = ordered.map((g) => coverSizeFor(g.copiesMillions));

// Cumulative X positions: each item gets spacing proportional to its size
const xPositions: number[] = [];
let cursor = 0;
for (let i = 0; i < N; i++) {
  // half of current item + a gap
  cursor += sizes[i].w * 0.5;
  xPositions.push(cursor);
  cursor += sizes[i].w * 0.5 + sizes[i].w * SPACING_GAP * 0.5;
  if (i + 1 < N) cursor += sizes[i + 1].w * SPACING_GAP * 0.5;
}
const rowTotalW = cursor;
for (let i = 0; i < N; i++) xPositions[i] -= rowTotalW / 2;

// Each item gets a slight Y/Z jitter to feel "floating in space"
const yOffsets = ordered.map((_, i) => Math.sin(i * 0.7) * 1.2);
const zOffsets = ordered.map((_, i) => Math.cos(i * 0.5) * 1.6);

function formatValue(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)}B`;
  return `${m}M`;
}

type Vec3 = [number, number, number];

// ───── Pacing (60fps) ─────
const PHASE_INTRO = 90;
const PHASE_TRAVEL = 1500;
const PHASE_HERO = 200;
const PHASE_OUTRO = 160;

export const TOTAL_FRAMES =
  PHASE_INTRO + PHASE_TRAVEL + PHASE_HERO + PHASE_OUTRO + 30;

// Per-item time weights — bigger covers (higher ranks) get more dwell time
const itemWeights: number[] = ordered.map((g) => {
  const t = Math.sqrt(g.copiesMillions / maxValue);
  return 0.7 + 1.3 * t; // small=0.7, hero=2.0
});
const cumWeights = [0];
for (let i = 0; i < itemWeights.length; i++)
  cumWeights.push(cumWeights[i] + itemWeights[i]);
const totalWeight = cumWeights[cumWeights.length - 1];

function progressToFloatIdx(p: number): number {
  const target = p * totalWeight;
  for (let i = 0; i < itemWeights.length; i++) {
    if (cumWeights[i + 1] >= target) {
      const segStart = cumWeights[i];
      const segEnd = cumWeights[i + 1];
      const f = (target - segStart) / (segEnd - segStart);
      return i + f;
    }
  }
  return itemWeights.length - 1;
}

// Camera distance scales with cover size so each cover frames consistently
const FOV_HALF_TAN = Math.tan((FOV * Math.PI) / 180 / 2);
function camDistFor(i: number): number {
  // Distance such that the cover height fills ~70% of vertical frame
  return (sizes[i].h * 0.5 * 1.45) / FOV_HALF_TAN;
}

function focusPose(i: number): { camPos: Vec3; lookAt: Vec3 } {
  const x = xPositions[i] + 0.4; // tiny lateral parallax
  const y = yOffsets[i] + 0.2;
  const z = zOffsets[i];
  const dist = camDistFor(i);
  return {
    camPos: [x, y, z + dist],
    lookAt: [xPositions[i], yOffsets[i], z],
  };
}

const startPose = (() => {
  const f = focusPose(0);
  return {
    camPos: [f.camPos[0] - 6, f.camPos[1] + 0.5, f.camPos[2] + 4] as Vec3,
    lookAt: [f.lookAt[0], f.lookAt[1], f.lookAt[2]] as Vec3,
  };
})();

const outroPose = (() => {
  const f = focusPose(N - 1);
  return {
    camPos: [f.camPos[0], f.camPos[1] + 1, f.camPos[2] + 8] as Vec3,
    lookAt: [f.lookAt[0], f.lookAt[1], f.lookAt[2]] as Vec3,
  };
})();

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}
function clamp01(t: number) {
  return Math.max(0, Math.min(1, t));
}
function smoothstep(t: number) {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

const easeInOut = Easing.bezier(0.45, 0, 0.2, 1);

function CameraRig({ frame }: { frame: number }) {
  const camera = useThree((s) => s.camera);

  let pos: Vec3;
  let look: Vec3;

  if (frame < PHASE_INTRO) {
    const t = frame / PHASE_INTRO;
    const e = easeInOut(t);
    pos = lerpVec3(startPose.camPos, focusPose(0).camPos, e);
    look = lerpVec3(startPose.lookAt, focusPose(0).lookAt, e);
  } else if (frame < PHASE_INTRO + PHASE_TRAVEL) {
    const tNorm = (frame - PHASE_INTRO) / PHASE_TRAVEL;
    const floatIdx = progressToFloatIdx(tNorm);
    const a = Math.min(Math.floor(floatIdx), N - 2);
    const b = a + 1;
    const f = smoothstep(floatIdx - a);
    pos = lerpVec3(focusPose(a).camPos, focusPose(b).camPos, f);
    look = lerpVec3(focusPose(a).lookAt, focusPose(b).lookAt, f);
  } else if (frame < PHASE_INTRO + PHASE_TRAVEL + PHASE_HERO) {
    pos = focusPose(N - 1).camPos;
    look = focusPose(N - 1).lookAt;
  } else {
    const t = clamp01(
      (frame - PHASE_INTRO - PHASE_TRAVEL - PHASE_HERO) / PHASE_OUTRO,
    );
    const e = easeInOut(t);
    pos = lerpVec3(focusPose(N - 1).camPos, outroPose.camPos, e);
    look = lerpVec3(focusPose(N - 1).lookAt, outroPose.lookAt, e);
  }

  // Subtle handheld drift
  const time = frame / 60;
  pos = [
    pos[0] + Math.sin(time * 0.7) * 0.04,
    pos[1] + Math.cos(time * 0.55) * 0.03,
    pos[2] + Math.sin(time * 0.45) * 0.03,
  ];

  camera.position.set(pos[0], pos[1], pos[2]);
  camera.lookAt(look[0], look[1], look[2]);
  camera.updateProjectionMatrix();
  return null;
}

// ───── Holographic label texture ─────
const LABEL_W = 1024;
const LABEL_H = 384;

function makeLabel(game: Game): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = LABEL_W;
  c.height = LABEL_H;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, LABEL_W, LABEL_H);

  const FONT =
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  const rankSize = Math.round(LABEL_H * 0.13);
  const nameMaxSize = Math.round(LABEL_H * 0.20);
  const valueSize = Math.round(LABEL_H * 0.42);

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  const nameLines = wrapText(ctx, game.title, LABEL_W * 0.92, nameMaxSize, 600);
  const actualName = nameLines[0].size;
  const nameLineH = actualName * 1.1;

  const gap1 = LABEL_H * 0.025;
  const gap2 = LABEL_H * 0.035;

  const blockH =
    rankSize + gap1 + nameLines.length * nameLineH + gap2 + valueSize;
  const topY = (LABEL_H - blockH) / 2;

  // Rank header — cyan, tracked
  ctx.fillStyle = HOLO_CYAN;
  ctx.font = `700 ${rankSize}px ${FONT}`;
  drawSpaced(
    ctx,
    `// RANK ${String(game.rank).padStart(2, "0")}`,
    LABEL_W / 2,
    topY + rankSize,
    rankSize * 0.18,
  );

  // Name — white
  ctx.fillStyle = "#ffffff";
  ctx.font = `600 ${actualName}px ${FONT}`;
  const nameY = topY + rankSize + gap1 + actualName;
  for (let i = 0; i < nameLines.length; i++) {
    ctx.fillText(nameLines[i].text, LABEL_W / 2, nameY + i * nameLineH);
  }

  // Value — cyan, dominant
  ctx.fillStyle = HOLO_CYAN;
  ctx.font = `700 ${valueSize}px ${FONT}`;
  const valueY = nameY + (nameLines.length - 1) * nameLineH + gap2 + valueSize;
  ctx.fillText(formatValue(game.copiesMillions), LABEL_W / 2, valueY);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  baseSize: number,
  weight: number,
): { text: string; size: number }[] {
  const FONT =
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  for (let size = baseSize; size >= baseSize * 0.55; size -= 4) {
    ctx.font = `${weight} ${size}px ${FONT}`;
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

// ───── Holographic frame texture (corner brackets, transparent) ─────
function makeHoloFrame(): THREE.CanvasTexture {
  const S = 1024;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, S, S);

  const margin = S * 0.04;
  const cornerLen = S * 0.12;
  const lw = S * 0.012;

  ctx.strokeStyle = HOLO_CYAN;
  ctx.lineWidth = lw;
  ctx.lineCap = "round";

  // Four corner brackets
  const drawCorner = (x: number, y: number, dx: number, dy: number) => {
    ctx.beginPath();
    ctx.moveTo(x + dx * cornerLen, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * cornerLen);
    ctx.stroke();
  };
  drawCorner(margin, margin, 1, 1);
  drawCorner(S - margin, margin, -1, 1);
  drawCorner(margin, S - margin, 1, -1);
  drawCorner(S - margin, S - margin, -1, -1);

  // Faint full border
  ctx.strokeStyle = "rgba(127, 214, 255, 0.18)";
  ctx.lineWidth = lw * 0.4;
  ctx.strokeRect(margin, margin, S - margin * 2, S - margin * 2);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ───── Floating cover ─────
function FloatingCover({
  game,
  index,
  coverTex,
  labelTex,
  holoTex,
}: {
  game: Game;
  index: number;
  coverTex: THREE.Texture;
  labelTex: THREE.Texture;
  holoTex: THREE.Texture;
}) {
  const { w, h } = sizes[index];
  const x = xPositions[index];
  const y = yOffsets[index];
  const z = zOffsets[index];

  const labelW = w * 1.1;
  const labelH = labelW * (LABEL_H / LABEL_W);

  return (
    <group position={[x, y, z]}>
      {/* Glow halo behind the cover */}
      <mesh position={[0, 0, -0.05]}>
        <planeGeometry args={[w * 1.35, h * 1.25]} />
        <meshBasicMaterial
          color={HOLO_DEEP}
          transparent
          opacity={0.18}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Cover image */}
      <mesh>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial map={coverTex} toneMapped={false} />
      </mesh>

      {/* Holographic frame brackets */}
      <mesh position={[0, 0, 0.01]}>
        <planeGeometry args={[w * 1.1, h * 1.05]} />
        <meshBasicMaterial
          map={holoTex}
          transparent
          depthWrite={false}
        />
      </mesh>

      {/* Floating label below */}
      <mesh position={[0, -h * 0.5 - labelH * 0.55, 0]}>
        <planeGeometry args={[labelW, labelH]} />
        <meshBasicMaterial map={labelTex} transparent depthWrite={false} />
      </mesh>
    </group>
  );
}

function Constellation() {
  const coverPaths = useMemo(
    () => ordered.map((g) => staticFile(`covers/${COVERS[g.rank]}`)),
    [],
  );
  const covers = useTexture(coverPaths);
  const labels = useMemo(() => ordered.map((g) => makeLabel(g)), []);
  const holoFrame = useMemo(() => makeHoloFrame(), []);

  useMemo(() => {
    covers.forEach((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 16;
    });
  }, [covers]);

  return (
    <>
      {ordered.map((g, i) => (
        <FloatingCover
          key={g.rank}
          game={g}
          index={i}
          coverTex={covers[i]}
          labelTex={labels[i]}
          holoTex={holoFrame}
        />
      ))}
    </>
  );
}

// Nebula background — large plane far behind everything with vertical gradient
function makeNebulaTexture(): THREE.CanvasTexture {
  const W = 256;
  const H = 1024;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, NEBULA_TOP);
  g.addColorStop(0.5, NEBULA_MID);
  g.addColorStop(1, NEBULA_BOT);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Faint blue glow patches for nebula clouds
  for (let i = 0; i < 6; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const r = 60 + Math.random() * 120;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "rgba(80, 130, 220, 0.18)");
    grad.addColorStop(1, "rgba(80, 130, 220, 0)");
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function Backdrop() {
  const nebula = useMemo(() => makeNebulaTexture(), []);
  return (
    <mesh position={[0, 0, -200]}>
      <planeGeometry args={[800, 400]} />
      <meshBasicMaterial map={nebula} />
    </mesh>
  );
}

function Scene() {
  return (
    <>
      <color attach="background" args={[BG_COLOR]} />
      <fog attach="fog" args={[BG_COLOR, 80, 260]} />

      {/* Starfield — drei's Stars points cloud */}
      <Stars
        radius={150}
        depth={80}
        count={3000}
        factor={3}
        saturation={0}
        fade
        speed={0.3}
      />

      <Backdrop />

      {/* Soft ambient so covers read */}
      <ambientLight intensity={1.4} color="#ffffff" />

      <Suspense fallback={null}>
        <Constellation />
      </Suspense>
    </>
  );
}

export const SpaceComposition = () => {
  const { width, height } = useVideoConfig();
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: BG_COLOR }}>
      <ThreeCanvas
        width={width}
        height={height}
        camera={{ fov: FOV, near: 0.1, far: 600 }}
        dpr={1}
        gl={{
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.2,
          antialias: true,
          powerPreference: "high-performance",
        }}
      >
        <Suspense fallback={null}>
          <Scene />
        </Suspense>
        <CameraRig frame={frame} />
      </ThreeCanvas>
    </AbsoluteFill>
  );
};
