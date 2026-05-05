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
import { Episode, EpisodeItem } from "./episode";

// ───── Geometry ─────
// ADJUST: cover (poster) size in 3D units. Bigger = poster fills more of frame.
const COVER_W = 9.5;
const COVER_H = 9.5;
const COVER_BORDER = 0.07;
const COVER_BORDER_DEPTH = 0.05;

// ADJUST: label plane (title + value text under each cover). Width matches a 2048x760 canvas.
const LABEL_PLANE_W = 10.0;
const LABEL_PLANE_H = (LABEL_PLANE_W * 760) / 2048; // 3.71
const LABEL_GAP = 0.45; // vertical gap between cover and label

// ADJUST: horizontal gap between cards. Bigger = more breathing room, longer camera travel.
const SPACING_X = 20.0;
const Z_JIG = 3.6; // alternating forward/back depth offset per card (visual interest)
const Y_JIG = 0.5; // subtle vertical wave across cards

const FOV = 30; // camera field of view (lower = more zoomed in / less perspective distortion)

// ADJUST: distance from first/last card to intro/outro title (in 3D units).
// More negative TITLE_DROP_X / more positive OUTRO_DROP_X = bigger gap.
const TITLE_DROP_X = -35;
const OUTRO_DROP_X = 35;

// ADJUST: intro/outro title plane size. Bigger = larger title text on screen.
const TITLE_PLANE_W = 18;
const TITLE_PLANE_H = TITLE_PLANE_W / 2;

// ───── Palette ─────
const BG_COLOR = "#040814";
const COVER_TRIM = "#1a1f2a";
const ACCENT_ORANGE = "#f5b35a";

// ───── Position helpers (depend on item count) ─────
const coverX = (i: number, n: number) =>
  i * SPACING_X - ((n - 1) * SPACING_X) / 2;
const coverZ = (i: number) => (i % 2 === 0 ? -Z_JIG : Z_JIG);
const coverY = (i: number) => 5 + Math.sin(i * 0.9) * Y_JIG;

const TITLE_Y = 5;
const OUTRO_Y = 5;

function formatValue(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)}B`;
  return `${m}M`;
}

type Vec3 = [number, number, number];
type FocusPose = { camPos: Vec3; lookAt: Vec3 };

// ADJUST: camera framing per card.
// CAM_DIST: distance from card. Bigger = card looks smaller / more space around it.
// CAM_Y_OFFSET: vertical camera offset. Negative = camera looks slightly upward at card.
// CAM_X_OFFSET: horizontal camera offset (small lateral nudge for composition).
const CAM_DIST = 36;
const CAM_Y_OFFSET = -3.0;
const CAM_X_OFFSET = 1.5;

function coverFocusPose(i: number, n: number): FocusPose {
  const x = coverX(i, n);
  const y = coverY(i);
  const z = coverZ(i);
  return {
    camPos: [x + CAM_X_OFFSET, y + CAM_Y_OFFSET, z + CAM_DIST],
    lookAt: [x, y - 0.6, z],
  };
}

// ───── Pacing (60fps) ─────
// ADJUST: all values are in frames @ 60fps. So 60 = 1 second.
// PHASE_INTRO: how long the intro title stays before camera starts moving to card #N.
// PER_ITEM_FRAMES: total time budget per card (includes both travel-to and dwell-on).
// TAIL_PADDING: how long the outro title stays at the end.
const PHASE_INTRO = 200; // ~3.3s intro
const PER_ITEM_FRAMES = 250; // ~5.5s per card
const TAIL_PADDING = 120; // ~2s outro hold

export function totalFrames(items: EpisodeItem[]): number {
  return PHASE_INTRO + items.length * PER_ITEM_FRAMES + TAIL_PADDING;
}

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

// ADJUST: how long each card stays still on screen before the camera moves on.
// Pause-per-card (seconds) = PER_ITEM_FRAMES * SEG_HOLD_FRAC / 60
// e.g. 330 * 0.52 / 60 ≈ 2.86s paused, then ~2.64s gliding to the next card.
// Higher SEG_HOLD_FRAC = longer pause / faster glide (same total video length).
// To make BOTH pause and glide longer, raise PER_ITEM_FRAMES instead.
const SEG_HOLD_FRAC = 0.4;
function segmentEase(t: number): number {
  const half = SEG_HOLD_FRAC / 2;
  if (t <= half) return 0;
  if (t >= 1 - half) return 1;
  const u = (t - half) / (1 - SEG_HOLD_FRAC);
  return smoothstep(u);
}

const easeInOut = Easing.bezier(0.45, 0, 0.2, 1);

// ───── Per-episode runtime ─────
type EpisodeRuntime = {
  items: EpisodeItem[];
  N: number;
  waypoints: FocusPose[];
  cumWeights: number[];
  totalWeight: number;
  startPose: FocusPose;
  titleX: number;
  outroX: number;
  travelFrames: number;
};

function buildRuntime(episode: Episode): EpisodeRuntime {
  const items = [...episode.items].sort((a, b) => b.rank - a.rank);
  const N = items.length;
  const maxValue = Math.max(...items.map((i) => i.value));
  const titleX = coverX(0, N) + TITLE_DROP_X;
  const outroX = coverX(N - 1, N) + OUTRO_DROP_X;
  const titleFocusPose: FocusPose = {
    camPos: [titleX + CAM_X_OFFSET, TITLE_Y + CAM_Y_OFFSET + 1, CAM_DIST],
    lookAt: [titleX, TITLE_Y - 0.4, 0],
  };
  const outroFocusPose: FocusPose = {
    camPos: [outroX + CAM_X_OFFSET, OUTRO_Y + CAM_Y_OFFSET + 1, CAM_DIST],
    lookAt: [outroX, OUTRO_Y - 0.4, 0],
  };
  const waypoints: FocusPose[] = [
    titleFocusPose,
    ...items.map((_, i) => coverFocusPose(i, N)),
    outroFocusPose,
  ];
  const weights: number[] = [
    2.6,
    ...items.map((it) => 0.85 + 1.0 * Math.sqrt(it.value / maxValue)),
    2.6,
  ];
  const cumWeights = [0];
  let acc = 0;
  for (const w of weights) {
    acc += w;
    cumWeights.push(acc);
  }
  const startPose: FocusPose = {
    camPos: [
      titleFocusPose.camPos[0] - 14,
      titleFocusPose.camPos[1] + 0.5,
      titleFocusPose.camPos[2] + 5,
    ],
    lookAt: [
      titleFocusPose.lookAt[0],
      titleFocusPose.lookAt[1],
      titleFocusPose.lookAt[2],
    ],
  };
  return {
    items,
    N,
    waypoints,
    cumWeights,
    totalWeight: acc,
    startPose,
    titleX,
    outroX,
    travelFrames: N * PER_ITEM_FRAMES,
  };
}

function progressToFloatIdx(p: number, runtime: EpisodeRuntime): number {
  const target = p * runtime.totalWeight;
  for (let i = 0; i < runtime.cumWeights.length - 1; i++) {
    if (runtime.cumWeights[i + 1] >= target) {
      const segStart = runtime.cumWeights[i];
      const segEnd = runtime.cumWeights[i + 1];
      const f = (target - segStart) / (segEnd - segStart);
      return i + f;
    }
  }
  return runtime.waypoints.length - 1;
}

function focalIdxAt(frame: number, runtime: EpisodeRuntime): number {
  if (frame < PHASE_INTRO) return 0;
  if (frame < PHASE_INTRO + runtime.travelFrames) {
    const tNorm = (frame - PHASE_INTRO) / runtime.travelFrames;
    return progressToFloatIdx(tNorm, runtime);
  }
  return runtime.waypoints.length - 1;
}

function CameraRig({
  frame,
  runtime,
}: {
  frame: number;
  runtime: EpisodeRuntime;
}) {
  const camera = useThree((s) => s.camera);

  let pos: Vec3;
  let look: Vec3;

  if (frame < PHASE_INTRO) {
    const t = frame / PHASE_INTRO;
    const e = easeInOut(t);
    pos = lerpVec3(runtime.startPose.camPos, runtime.waypoints[0].camPos, e);
    look = lerpVec3(runtime.startPose.lookAt, runtime.waypoints[0].lookAt, e);
  } else {
    const tNorm = clamp01((frame - PHASE_INTRO) / runtime.travelFrames);
    const floatIdx = progressToFloatIdx(tNorm, runtime);
    const a = Math.min(Math.floor(floatIdx), runtime.waypoints.length - 2);
    const b = a + 1;
    const f = segmentEase(floatIdx - a);
    pos = lerpVec3(runtime.waypoints[a].camPos, runtime.waypoints[b].camPos, f);
    look = lerpVec3(
      runtime.waypoints[a].lookAt,
      runtime.waypoints[b].lookAt,
      f,
    );
  }

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

// ───── Cover label texture ─────
const LABEL_W = 2048;
const LABEL_H = 760;

function makeLabel(item: EpisodeItem, unitLabel: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = LABEL_W;
  c.height = LABEL_H;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, LABEL_W, LABEL_H);

  const FONT =
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  // ADJUST: text sizes for the title (movie/game name) and value (e.g. "2.9B").
  // Multiplier of LABEL_H (760). Larger = bigger text. Wraps + auto-shrinks if too wide.
  const titleBaseSize = Math.round(LABEL_H * 0.34);
  const valueSize = Math.round(LABEL_H * 0.27);

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  const lines = wrapText(ctx, item.title, LABEL_W * 0.94, titleBaseSize, 700);
  const actualTitle = lines[0].size;
  const titleLineH = actualTitle * 1.08;

  const valueGap = LABEL_H * 0.05;
  const blockH = lines.length * titleLineH + valueGap + valueSize;
  const topY = Math.max(LABEL_H * 0.08, (LABEL_H - blockH) / 2);

  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${actualTitle}px ${FONT}`;
  for (let i = 0; i < lines.length; i++) {
    const y = topY + actualTitle + i * titleLineH;
    ctx.fillText(lines[i].text, LABEL_W / 2, y);
  }

  // Auto-shrink the value line so long unit labels never clip horizontally
  const valueText = `${formatValue(item.value)} ${unitLabel}`;
  const valueMaxW = LABEL_W * 0.94;
  let actualValueSize = valueSize;
  ctx.font = `600 ${actualValueSize}px ${FONT}`;
  while (
    ctx.measureText(valueText).width > valueMaxW &&
    actualValueSize > Math.round(valueSize * 0.5)
  ) {
    actualValueSize -= 4;
    ctx.font = `600 ${actualValueSize}px ${FONT}`;
  }
  ctx.fillStyle = ACCENT_ORANGE;
  const valueY = topY + lines.length * titleLineH + valueGap + actualValueSize;
  ctx.fillText(valueText, LABEL_W / 2, valueY);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
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

  for (let size = baseSize; size >= Math.round(baseSize * 0.8); size -= 4) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    if (ctx.measureText(text).width <= maxWidth) {
      return [{ text, size }];
    }
  }
  for (
    let size = Math.round(baseSize * 0.78);
    size >= Math.round(baseSize * 0.55);
    size -= 4
  ) {
    ctx.font = `${weight} ${size}px ${FONT}`;
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
  return [{ text, size: Math.round(baseSize * 0.55) }];
}

// ───── Rank badge texture ─────
const RANK_W = 1024;
const RANK_H = 512;

function makeRankTex(rank: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = RANK_W;
  c.height = RANK_H;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, RANK_W, RANK_H);

  const FONT =
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  const rankStr = String(rank).padStart(2, "0");
  const size = Math.round(RANK_H * 0.78);

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 6;

  ctx.font = `900 ${size}px ${FONT}`;

  const hash = "#";
  const hashW = ctx.measureText(hash).width;
  const numW = ctx.measureText(rankStr).width;
  const gap = size * 0.04;
  const totalW = hashW + gap + numW;
  const startX = (RANK_W - totalW) / 2;
  const baselineY = RANK_H * 0.5 + size * 0.36;

  ctx.fillStyle = ACCENT_ORANGE;
  ctx.fillText(hash, startX + hashW / 2, baselineY);
  ctx.fillText(rankStr, startX + hashW + gap + numW / 2, baselineY);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

const RANK_PLANE_W = 4.5;
const RANK_PLANE_H = (RANK_PLANE_W * RANK_H) / RANK_W;
const RANK_GAP = 0.5;

// ───── Title / outro text textures ─────
const TITLE_TEX_W = 2048;
const TITLE_TEX_H = 1024;

function makeTitleTexture(
  line1: string,
  line2: string,
  accent: boolean,
): THREE.CanvasTexture {
  const W = TITLE_TEX_W;
  const H = TITLE_TEX_H;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);

  const FONT =
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  const line1MaxW = W * 0.92;
  let line1Size = Math.round(H * 0.18);
  ctx.font = `800 ${line1Size}px ${FONT}`;
  while (
    ctx.measureText(line1).width > line1MaxW &&
    line1Size > Math.round(H * 0.08)
  ) {
    line1Size -= 4;
    ctx.font = `800 ${line1Size}px ${FONT}`;
  }

  const line2MaxW = W * 0.92;
  let line2Size = Math.round(H * 0.085);
  ctx.font = `500 ${line2Size}px ${FONT}`;
  while (
    ctx.measureText(line2).width > line2MaxW &&
    line2Size > Math.round(H * 0.04)
  ) {
    line2Size -= 2;
    ctx.font = `500 ${line2Size}px ${FONT}`;
  }

  const gap = H * 0.04;
  const blockH = line1Size + gap + line2Size;
  const topY = (H - blockH) / 2;

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = "#ffffff";
  ctx.font = `800 ${line1Size}px ${FONT}`;
  ctx.fillText(line1, W / 2, topY + line1Size);

  ctx.fillStyle = accent ? ACCENT_ORANGE : "rgba(255,255,255,0.78)";
  ctx.font = `500 ${line2Size}px ${FONT}`;
  ctx.fillText(line2, W / 2, topY + line1Size + gap + line2Size);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

// ───── Floating cover ─────
function FloatingCover({
  index,
  N,
  coverTex,
  labelTex,
  rankTex,
  focalIdx,
}: {
  index: number;
  N: number;
  coverTex: THREE.Texture;
  labelTex: THREE.Texture;
  rankTex: THREE.Texture;
  focalIdx: number;
}) {
  const x = coverX(index, N);
  const y = coverY(index);
  const z = coverZ(index);

  const myWaypointIdx = index + 1;
  const d = Math.abs(myWaypointIdx - focalIdx);
  const boost = 0.1 * Math.exp(-d * d * 0.5);
  const scale = 1 + boost;

  const labelY = -COVER_H / 2 - LABEL_GAP - LABEL_PLANE_H / 2;
  const rankY = COVER_H / 2 + RANK_GAP + RANK_PLANE_H / 2;

  return (
    <group position={[x, y, z]}>
      <mesh position={[0, rankY, 0.02]}>
        <planeGeometry args={[RANK_PLANE_W, RANK_PLANE_H]} />
        <meshBasicMaterial map={rankTex} transparent depthWrite={false} />
      </mesh>

      <mesh scale={[scale, scale, 1]} position={[0, 0, -COVER_BORDER_DEPTH]}>
        <boxGeometry
          args={[
            COVER_W + COVER_BORDER * 2,
            COVER_H + COVER_BORDER * 2,
            COVER_BORDER_DEPTH,
          ]}
        />
        <meshStandardMaterial
          color={COVER_TRIM}
          roughness={0.6}
          metalness={0.2}
        />
      </mesh>

      <mesh scale={[scale, scale, 1]}>
        <planeGeometry args={[COVER_W, COVER_H]} />
        <meshStandardMaterial
          map={coverTex}
          roughness={0.45}
          metalness={0}
          emissive="#222"
          emissiveIntensity={0.25}
          emissiveMap={coverTex}
        />
      </mesh>

      <mesh position={[0, labelY, 0.02]}>
        <planeGeometry args={[LABEL_PLANE_W, LABEL_PLANE_H]} />
        <meshBasicMaterial map={labelTex} transparent depthWrite={false} />
      </mesh>
    </group>
  );
}

// ───── Title / outro boards ─────
function TextBoard({
  position,
  texture,
}: {
  position: Vec3;
  texture: THREE.Texture;
}) {
  return (
    <group position={position}>
      <mesh>
        <planeGeometry args={[TITLE_PLANE_W, TITLE_PLANE_H]} />
        <meshBasicMaterial map={texture} transparent depthWrite={false} />
      </mesh>
    </group>
  );
}

function CoverRow({
  frame,
  episode,
  runtime,
}: {
  frame: number;
  episode: Episode;
  runtime: EpisodeRuntime;
}) {
  const coverPaths = useMemo(
    () => runtime.items.map((it) => staticFile(it.imagePath ?? "")),
    [runtime.items],
  );
  const covers = useTexture(coverPaths);
  const labels = useMemo(
    () => runtime.items.map((it) => makeLabel(it, episode.unitLabel)),
    [runtime.items, episode.unitLabel],
  );
  const ranks = useMemo(
    () => runtime.items.map((it) => makeRankTex(it.rank)),
    [runtime.items],
  );
  const titleTex = useMemo(
    () => makeTitleTexture(episode.title[0], episode.title[1], false),
    [episode.title],
  );
  const outroTex = useMemo(
    () => makeTitleTexture(episode.outro[0], episode.outro[1], true),
    [episode.outro],
  );

  useMemo(() => {
    const planeAspect = COVER_W / COVER_H;
    covers.forEach((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 16;
      const img = t.image as { width?: number; height?: number } | undefined;
      if (img && img.width && img.height) {
        const imgAspect = img.width / img.height;
        if (imgAspect > planeAspect) {
          const r = planeAspect / imgAspect;
          t.repeat.set(r, 1);
          t.offset.set((1 - r) / 2, 0);
        } else {
          const r = imgAspect / planeAspect;
          t.repeat.set(1, r);
          t.offset.set(0, (1 - r) / 2);
        }
        t.needsUpdate = true;
      }
    });
  }, [covers]);

  const focal = focalIdxAt(frame, runtime);

  return (
    <>
      <TextBoard position={[runtime.titleX, TITLE_Y, 0]} texture={titleTex} />
      {runtime.items.map((item, i) => (
        <FloatingCover
          key={item.rank}
          index={i}
          N={runtime.N}
          coverTex={covers[i]}
          labelTex={labels[i]}
          rankTex={ranks[i]}
          focalIdx={focal}
        />
      ))}
      <TextBoard position={[runtime.outroX, OUTRO_Y, 0]} texture={outroTex} />
    </>
  );
}

// ───── Starfield + nebula backdrop ─────
// Math.random is fine here: this canvas is built ONCE per mount via useMemo,
// not per-frame. Each render gets a stable starfield.
/* eslint-disable @remotion/deterministic-randomness */
function makeSpaceTexture(): THREE.CanvasTexture {
  const W = 4096;
  const H = 2048;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;

  const base = ctx.createLinearGradient(0, 0, W, H);
  base.addColorStop(0, "#070d1c");
  base.addColorStop(0.55, "#03060f");
  base.addColorStop(1, "#01020a");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);

  ctx.globalCompositeOperation = "screen";
  type Nebula = { x: number; y: number; r: number; color: string; a: number };
  const nebulae: Nebula[] = [
    { x: 0.16, y: 0.26, r: 0.4, color: "120, 160, 230", a: 0.32 },
    { x: 0.22, y: 0.18, r: 0.2, color: "160, 200, 255", a: 0.18 },
    { x: 0.1, y: 0.34, r: 0.16, color: "80, 120, 200", a: 0.14 },
    { x: 0.72, y: 0.52, r: 0.32, color: "200, 90, 170", a: 0.2 },
    { x: 0.78, y: 0.48, r: 0.16, color: "240, 130, 200", a: 0.14 },
    { x: 0.68, y: 0.6, r: 0.12, color: "180, 60, 140", a: 0.12 },
    { x: 0.44, y: 0.72, r: 0.22, color: "230, 150, 90", a: 0.1 },
    { x: 0.48, y: 0.78, r: 0.1, color: "255, 180, 120", a: 0.1 },
    { x: 0.85, y: 0.3, r: 0.2, color: "80, 200, 220", a: 0.1 },
    { x: 0.2, y: 0.78, r: 0.24, color: "180, 50, 60", a: 0.08 },
    { x: 0.28, y: 0.85, r: 0.12, color: "220, 80, 80", a: 0.08 },
  ];
  for (const n of nebulae) {
    const cx = W * n.x;
    const cy = H * n.y;
    const r = W * n.r;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(${n.color}, ${n.a})`);
    g.addColorStop(0.45, `rgba(${n.color}, ${n.a * 0.35})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(-0.22);
  const band = ctx.createLinearGradient(0, -H * 0.35, 0, H * 0.35);
  band.addColorStop(0, "rgba(0,0,0,0)");
  band.addColorStop(0.45, "rgba(120, 130, 180, 0.05)");
  band.addColorStop(0.5, "rgba(180, 170, 200, 0.09)");
  band.addColorStop(0.55, "rgba(120, 130, 180, 0.05)");
  band.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = band;
  ctx.fillRect(-W, -H * 0.35, W * 2, H * 0.7);
  ctx.restore();

  for (let i = 0; i < 14; i++) {
    const cx = Math.random() * W;
    const cy = Math.random() * H;
    const rx = 8 + Math.random() * 16;
    const ry = rx * (0.35 + Math.random() * 0.4);
    const rot = Math.random() * Math.PI;
    const tint = Math.random() < 0.5 ? "200, 180, 160" : "160, 180, 220";
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, `rgba(${tint}, 0.55)`);
    g.addColorStop(0.4, `rgba(${tint}, 0.20)`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.globalCompositeOperation = "source-over";

  const STAR_PALETTE: Array<[number, number, number]> = [
    [180, 200, 255],
    [210, 220, 255],
    [255, 255, 255],
    [255, 245, 220],
    [255, 220, 180],
    [255, 180, 140],
  ];
  const STAR_WEIGHTS = [0.05, 0.12, 0.3, 0.3, 0.15, 0.08];
  const cumStarW: number[] = [];
  let acc = 0;
  for (const w of STAR_WEIGHTS) {
    acc += w;
    cumStarW.push(acc);
  }
  function pickStarColor(): [number, number, number] {
    const r = Math.random();
    for (let i = 0; i < cumStarW.length; i++) {
      if (r <= cumStarW[i]) return STAR_PALETTE[i];
    }
    return STAR_PALETTE[2];
  }

  const imageData = ctx.getImageData(0, 0, W, H);
  const data = imageData.data;
  for (let i = 0; i < 9000; i++) {
    const px = Math.floor(Math.random() * W);
    const py = Math.floor(Math.random() * H);
    const a = 0.08 + Math.random() * 0.25;
    const [r, g, b] = pickStarColor();
    const idx = (py * W + px) * 4;
    const ex = data[idx],
      ey = data[idx + 1],
      ez = data[idx + 2];
    data[idx] = Math.min(255, ex + r * a);
    data[idx + 1] = Math.min(255, ey + g * a);
    data[idx + 2] = Math.min(255, ez + b * a);
    data[idx + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);

  // Medium stars (2-3px) with soft halo — dimmed
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 350; i++) {
    const cx = Math.random() * W;
    const cy = Math.random() * H;
    const [r, g, b] = pickStarColor();
    const size = 1 + Math.random() * 1.5;
    const haloR = size * 5;
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
    halo.addColorStop(0, `rgba(${r},${g},${b},0.28)`);
    halo.addColorStop(0.4, `rgba(${r},${g},${b},0.06)`);
    halo.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(${r},${g},${b},0.55)`;
    ctx.beginPath();
    ctx.arc(cx, cy, size, 0, Math.PI * 2);
    ctx.fill();
  }

  // Hero stars with diffraction spikes — significantly dimmed
  for (let i = 0; i < 18; i++) {
    const cx = Math.random() * W;
    const cy = Math.random() * H;
    const [r, g, b] = pickStarColor();
    const haloR = 22 + Math.random() * 22;
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
    halo.addColorStop(0, `rgba(${r},${g},${b},0.40)`);
    halo.addColorStop(0.25, `rgba(${r},${g},${b},0.10)`);
    halo.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
    ctx.fill();
    const spikeLen = haloR * 1.4;
    const spike = ctx.createLinearGradient(
      cx - spikeLen,
      cy,
      cx + spikeLen,
      cy,
    );
    spike.addColorStop(0, "rgba(0,0,0,0)");
    spike.addColorStop(0.5, `rgba(${r},${g},${b},0.22)`);
    spike.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = spike;
    ctx.fillRect(cx - spikeLen, cy - 0.5, spikeLen * 2, 1);
    const spikeV = ctx.createLinearGradient(
      cx,
      cy - spikeLen,
      cx,
      cy + spikeLen,
    );
    spikeV.addColorStop(0, "rgba(0,0,0,0)");
    spikeV.addColorStop(0.5, `rgba(${r},${g},${b},0.22)`);
    spikeV.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = spikeV;
    ctx.fillRect(cx - 0.5, cy - spikeLen, 1, spikeLen * 2);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";

  // Distant "planets" — a handful of larger filled bodies (no spikes, no halo)
  // so they read as solid surfaces rather than glowing stars. Subtle inner
  // shading + faint atmospheric ring sells the planet feel.
  const PLANET_COLORS: Array<[number, number, number]> = [
    [180, 130, 90], // warm rusty (Mars-like)
    [210, 180, 130], // pale tan (Saturn-like)
    [110, 140, 190], // cool blue (Neptune-like)
    [160, 110, 140], // dusty rose
    [120, 160, 130], // muted teal
  ];
  const PLANET_COUNT = 5;
  for (let i = 0; i < PLANET_COUNT; i++) {
    const cx = Math.random() * W;
    const cy = Math.random() * H;
    const radius = 14 + Math.random() * 22; // 14–36px surface
    const [pr, pg, pb] = PLANET_COLORS[i % PLANET_COLORS.length];
    // Subtle outer atmosphere glow (very low opacity)
    const atmoR = radius * 1.45;
    const atmo = ctx.createRadialGradient(cx, cy, radius, cx, cy, atmoR);
    atmo.addColorStop(0, `rgba(${pr},${pg},${pb},0.18)`);
    atmo.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = atmo;
    ctx.beginPath();
    ctx.arc(cx, cy, atmoR, 0, Math.PI * 2);
    ctx.fill();
    // Surface — radial shading from lit edge to terminator
    const lightX = cx - radius * 0.35;
    const lightY = cy - radius * 0.35;
    const surface = ctx.createRadialGradient(
      lightX,
      lightY,
      radius * 0.1,
      cx,
      cy,
      radius,
    );
    surface.addColorStop(0, `rgba(${Math.min(255, pr + 35)},${Math.min(255, pg + 35)},${Math.min(255, pb + 35)},1)`);
    surface.addColorStop(0.55, `rgba(${pr},${pg},${pb},1)`);
    surface.addColorStop(1, `rgba(${Math.round(pr * 0.45)},${Math.round(pg * 0.45)},${Math.round(pb * 0.45)},1)`);
    ctx.fillStyle = surface;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
/* eslint-enable @remotion/deterministic-randomness */

function Backdrop() {
  const space = useMemo(() => makeSpaceTexture(), []);
  return (
    <mesh position={[0, 0, -250]}>
      <planeGeometry args={[1800, 900]} />
      <meshBasicMaterial map={space} />
    </mesh>
  );
}

function Scene({
  frame,
  episode,
  runtime,
}: {
  frame: number;
  episode: Episode;
  runtime: EpisodeRuntime;
}) {
  return (
    <>
      <color attach="background" args={[BG_COLOR]} />
      <Backdrop />

      <ambientLight intensity={0.7} color="#cfdcef" />
      <directionalLight
        position={[-30, 25, 20]}
        intensity={1.0}
        color="#cbe0ff"
      />
      <directionalLight
        position={[15, 10, 25]}
        intensity={0.4}
        color="#ffe2c0"
      />

      <Suspense fallback={null}>
        <CoverRow frame={frame} episode={episode} runtime={runtime} />
      </Suspense>
    </>
  );
}

export const SkySlidesComposition: React.FC<{ episode: Episode }> = ({
  episode,
}) => {
  const { width, height } = useVideoConfig();
  const frame = useCurrentFrame();
  const runtime = useMemo(() => buildRuntime(episode), [episode]);
  return (
    <AbsoluteFill style={{ background: BG_COLOR }}>
      <ThreeCanvas
        width={width}
        height={height}
        camera={{ fov: FOV, near: 0.1, far: 600 }}
        dpr={1}
        gl={{
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.15,
          antialias: true,
          powerPreference: "high-performance",
        }}
      >
        <Suspense fallback={null}>
          <Scene frame={frame} episode={episode} runtime={runtime} />
        </Suspense>
        <CameraRig frame={frame} runtime={runtime} />
      </ThreeCanvas>
    </AbsoluteFill>
  );
};
