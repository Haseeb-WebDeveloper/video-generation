import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import { useMemo, Suspense } from "react";
import {
  AbsoluteFill,
  Audio,
  Easing,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Episode, EpisodeItem } from "./episode";

// ───── Geometry ─────
// Same cover sizing rules as sky-slides — covers fit inside a max bounding
// box; landscape/portrait images shrink to fit without cropping.
// Fixed height for every cover. Width follows the image's native aspect —
// portraits are narrow, landscapes are wide — but heights stay uniform so
// every card occupies the same vertical band on screen. With label/rank
// anchored to this height, the label and rank Y positions are also constant
// across the row, eliminating per-card size variation.
const COVER_H = 9.0;
const COVER_BORDER = 0.07;
const COVER_BORDER_DEPTH = 0.05;

function fitCoverDims(imgW: number, imgH: number): { w: number; h: number } {
  if (!imgW || !imgH) return { w: COVER_H, h: COVER_H };
  const aspect = imgW / imgH;
  return { w: COVER_H * aspect, h: COVER_H };
}

const LABEL_PLANE_W = 11.5;
const LABEL_PLANE_H = (LABEL_PLANE_W * 760) / 2048;
const LABEL_GAP = 0.45;

// Fixed EDGE-TO-EDGE gap between adjacent cards. Card center positions are
// derived from cumulative card widths plus this gap, so a wide landscape
// card sitting next to a narrow portrait card has the same visual breathing
// room as two square cards. (Center-to-center spacing made narrow cards
// look isolated — bigger gap to neighbors — and wide cards crowded.)
const CARD_GAP = 10.0;

const FOV = 30;

// Intro title sits TITLE_DROP_X units left of the first card; outro title
// sits OUTRO_DROP_X units right of the last card. Smaller buffers = camera
// reaches the title sooner. Outro is intentionally tighter so the closing
// title appears quickly after the last card.
const TITLE_DROP_X = -22;
const OUTRO_DROP_X = 20;
const TITLE_PLANE_W = 18;
const TITLE_PLANE_H = TITLE_PLANE_W / 2;

// ───── Palette ─────
const BG_COLOR = "#040814";
const COVER_TRIM = "#1a1f2a";
const ACCENT_ORANGE = "#f5b35a";

// Every card sits on the same flat row at this Y/Z. No per-index jig — a
// uniform formation so perspective doesn't make some cards render larger.
const ROW_Y = 5;
const ROW_Z = 0;

const TITLE_Y = ROW_Y;
const OUTRO_Y = ROW_Y;

function formatValue(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)}B`;
  return `${m}M`;
}

type Vec3 = [number, number, number];

// ADJUST: camera framing. Same closeness as sky-slides so cards read at the
// same big size. The continuous pan flows the row past the camera; with
// CARD_GAP-based positioning, one or two cards stay in frame at a time
// regardless of their individual aspect ratios.
const CAM_DIST = 36;
const CAM_Y_OFFSET = -3.0;
// Symmetric framing during a continuous pan — no lateral nudge.
const CAM_X_OFFSET = 0;

// ───── Pacing (60fps) ─────
// Continuous pan: camera glides linearly through the row with no per-card
// hold. PER_ITEM_FRAMES is the time budget per card — bigger = slower pan.
// At CAM_DIST = 36 each card has a narrower transit window than the wide
// framing did, so we slow down a bit to keep ~3s of clear read time per card.
const PHASE_INTRO = 70; // ~1s swoop-in (no intro title board to read)
const PER_ITEM_FRAMES = 300; // ~5s per card-spacing of camera travel
const TAIL_PADDING = 120; // ~2s outro hold

export function totalFrames(items: EpisodeItem[]): number {
  return PHASE_INTRO + items.length * PER_ITEM_FRAMES + TAIL_PADDING;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function clamp01(t: number) {
  return Math.max(0, Math.min(1, t));
}

const easeInOut = Easing.bezier(0.45, 0, 0.2, 1);

// ───── Layout ─────
// Computed from actual cover dimensions (widths come from loaded textures).
// `centers[i]` is the X position of card i's center; the camera path
// derives titleX/outroX/startCamX from those endpoints.
type Layout = {
  centers: number[];
  titleX: number;
  outroX: number;
  startCamX: number;
  travelFrames: number;
};

function buildLayout(coverWidths: number[]): Layout {
  const N = coverWidths.length;
  const total =
    coverWidths.reduce((a, b) => a + b, 0) + Math.max(0, N - 1) * CARD_GAP;
  const centers: number[] = [];
  let cursor = -total / 2;
  for (let i = 0; i < N; i++) {
    cursor += coverWidths[i] / 2;
    centers.push(cursor);
    cursor += coverWidths[i] / 2 + CARD_GAP;
  }
  const first = centers[0] ?? 0;
  const last = centers[N - 1] ?? 0;
  const titleX = first + TITLE_DROP_X;
  const outroX = last + OUTRO_DROP_X;
  const startCamX = titleX - 14;
  return {
    centers,
    titleX,
    outroX,
    startCamX,
    travelFrames: N * PER_ITEM_FRAMES,
  };
}

function cameraXAt(frame: number, layout: Layout): number {
  if (frame < PHASE_INTRO) {
    const t = easeInOut(clamp01(frame / PHASE_INTRO));
    return lerp(layout.startCamX, layout.titleX, t);
  }
  const travelEnd = PHASE_INTRO + layout.travelFrames;
  if (frame < travelEnd) {
    const t = clamp01((frame - PHASE_INTRO) / layout.travelFrames);
    return lerp(layout.titleX, layout.outroX, t);
  }
  return layout.outroX;
}

function CameraRig({
  frame,
  layout,
}: {
  frame: number;
  layout: Layout;
}) {
  const camera = useThree((s) => s.camera);

  const x = cameraXAt(frame, layout);
  const lookY = TITLE_Y - 0.6;

  const time = frame / 60;
  const px = x + CAM_X_OFFSET + Math.sin(time * 0.7) * 0.04;
  const py = TITLE_Y + CAM_Y_OFFSET + Math.cos(time * 0.55) * 0.03;
  const pz = CAM_DIST + Math.sin(time * 0.45) * 0.03;

  camera.position.set(px, py, pz);
  camera.lookAt(x, lookY, 0);
  camera.updateProjectionMatrix();
  return null;
}

// ───── Cover label texture ─────
const LABEL_W = 2048;
const LABEL_H = 760;

// Pick a single font size for the whole episode: the largest size where the
// longest value text still fits in the label width. Every card then renders
// its title and value at this exact size — no per-card auto-shrinking, no
// per-card variation. Min/max are chosen so 1-line and 2-line titles always
// fit within the label canvas height.
const LABEL_FONT_BASE = Math.round(LABEL_H * 0.32); // ~243
const LABEL_FONT_MIN = Math.round(LABEL_H * 0.13); // ~99

function chooseLabelFontSize(
  items: EpisodeItem[],
  unitLabel: string,
): number {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  const FONT =
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  const maxW = LABEL_W * 0.94;

  ctx.font = `600 ${LABEL_FONT_BASE}px ${FONT}`;
  let widest = 0;
  for (const it of items) {
    const text = `${formatValue(it.value)} ${unitLabel}`;
    const w = ctx.measureText(text).width;
    if (w > widest) widest = w;
  }
  if (widest <= maxW) return LABEL_FONT_BASE;
  const fit = Math.floor(LABEL_FONT_BASE * (maxW / widest));
  return Math.max(LABEL_FONT_MIN, fit);
}

function makeLabel(
  item: EpisodeItem,
  unitLabel: string,
  fontSize: number,
): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = LABEL_W;
  c.height = LABEL_H;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, LABEL_W, LABEL_H);

  const FONT =
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  const valueText = `${formatValue(item.value)} ${unitLabel}`;
  const maxW = LABEL_W * 0.94;

  // Title may need to wrap to 2 lines at the fixed size. Value stays single
  // line — its size already drove the episode-wide font size selection so
  // it's guaranteed to fit.
  let titleLines: string[];
  ctx.font = `700 ${fontSize}px ${FONT}`;
  if (ctx.measureText(item.title).width <= maxW) {
    titleLines = [item.title];
  } else {
    const words = item.title.split(" ");
    let wrapped: string[] | null = null;
    for (let split = 1; split < words.length; split++) {
      const l1 = words.slice(0, split).join(" ");
      const l2 = words.slice(split).join(" ");
      if (
        ctx.measureText(l1).width <= maxW &&
        ctx.measureText(l2).width <= maxW
      ) {
        wrapped = [l1, l2];
        break;
      }
    }
    titleLines = wrapped ?? [item.title];
  }

  const lineH = fontSize * 1.08;
  const valueGap = LABEL_H * 0.05;
  const topY = LABEL_H * 0.08;

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${fontSize}px ${FONT}`;
  for (let i = 0; i < titleLines.length; i++) {
    const y = topY + fontSize + i * lineH;
    ctx.fillText(titleLines[i], LABEL_W / 2, y);
  }

  ctx.fillStyle = ACCENT_ORANGE;
  ctx.font = `600 ${fontSize}px ${FONT}`;
  const valueY = topY + titleLines.length * lineH + valueGap + fontSize;
  ctx.fillText(valueText, LABEL_W / 2, valueY);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
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

const RANK_PLANE_W = 3.4;
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
  x,
  coverTex,
  labelTex,
  rankTex,
  coverW,
  coverH,
}: {
  x: number;
  coverTex: THREE.Texture;
  labelTex: THREE.Texture;
  rankTex: THREE.Texture;
  coverW: number;
  coverH: number;
}) {
  // Anchor label / rank to this cover's ACTUAL fitted height so the rank,
  // image, title, and value always sit as a tight stack regardless of
  // aspect ratio.
  const labelY = -coverH / 2 - LABEL_GAP - LABEL_PLANE_H / 2;
  const rankY = coverH / 2 + RANK_GAP + RANK_PLANE_H / 2;

  return (
    <group position={[x, ROW_Y, ROW_Z]}>
      <mesh position={[0, rankY, 0.02]}>
        <planeGeometry args={[RANK_PLANE_W, RANK_PLANE_H]} />
        <meshBasicMaterial map={rankTex} transparent depthWrite={false} />
      </mesh>

      <mesh position={[0, 0, -COVER_BORDER_DEPTH]}>
        <boxGeometry
          args={[
            coverW + COVER_BORDER * 2,
            coverH + COVER_BORDER * 2,
            COVER_BORDER_DEPTH,
          ]}
        />
        <meshStandardMaterial
          color={COVER_TRIM}
          roughness={0.6}
          metalness={0.2}
        />
      </mesh>

      <mesh>
        <planeGeometry args={[coverW, coverH]} />
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


// ───── Starfield + nebula backdrop ─────
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

  // Muted, no-pure-white palette so stars read as ambient backdrop instead
  // of distracting bright dots. Cooler shades on top, warmer below.
  const STAR_PALETTE: Array<[number, number, number]> = [
    [140, 160, 200],
    [165, 180, 205],
    [195, 200, 205],
    [215, 200, 170],
    [200, 175, 140],
    [180, 140, 105],
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

  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 180; i++) {
    const cx = Math.random() * W;
    const cy = Math.random() * H;
    const [r, g, b] = pickStarColor();
    const size = 1 + Math.random() * 1.5;
    const haloR = size * 5;
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
    halo.addColorStop(0, `rgba(${r},${g},${b},0.16)`);
    halo.addColorStop(0.4, `rgba(${r},${g},${b},0.04)`);
    halo.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(${r},${g},${b},0.30)`;
    ctx.beginPath();
    ctx.arc(cx, cy, size, 0, Math.PI * 2);
    ctx.fill();
  }

  // Hero stars are by far the most distracting element on the row, so we
  // keep just a handful and dial the spike/halo intensity way down.
  for (let i = 0; i < 6; i++) {
    const cx = Math.random() * W;
    const cy = Math.random() * H;
    const [r, g, b] = pickStarColor();
    const haloR = 22 + Math.random() * 22;
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
    halo.addColorStop(0, `rgba(${r},${g},${b},0.22)`);
    halo.addColorStop(0.25, `rgba(${r},${g},${b},0.06)`);
    halo.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
    ctx.fill();
    const spikeLen = haloR * 1.2;
    const spike = ctx.createLinearGradient(
      cx - spikeLen,
      cy,
      cx + spikeLen,
      cy,
    );
    spike.addColorStop(0, "rgba(0,0,0,0)");
    spike.addColorStop(0.5, `rgba(${r},${g},${b},0.12)`);
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
    spikeV.addColorStop(0.5, `rgba(${r},${g},${b},0.12)`);
    spikeV.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = spikeV;
    ctx.fillRect(cx - 0.5, cy - spikeLen, 1, spikeLen * 2);
    ctx.fillStyle = `rgba(${r},${g},${b},0.30)`;
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";

  const PLANET_COLORS: Array<[number, number, number]> = [
    [180, 130, 90],
    [210, 180, 130],
    [110, 140, 190],
    [160, 110, 140],
    [120, 160, 130],
  ];
  const PLANET_COUNT = 5;
  for (let i = 0; i < PLANET_COUNT; i++) {
    const cx = Math.random() * W;
    const cy = Math.random() * H;
    const radius = 14 + Math.random() * 22;
    const [pr, pg, pb] = PLANET_COLORS[i % PLANET_COLORS.length];
    const atmoR = radius * 1.45;
    const atmo = ctx.createRadialGradient(cx, cy, radius, cx, cy, atmoR);
    atmo.addColorStop(0, `rgba(${pr},${pg},${pb},0.18)`);
    atmo.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = atmo;
    ctx.beginPath();
    ctx.arc(cx, cy, atmoR, 0, Math.PI * 2);
    ctx.fill();
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
    surface.addColorStop(
      0,
      `rgba(${Math.min(255, pr + 35)},${Math.min(255, pg + 35)},${Math.min(255, pb + 35)},1)`,
    );
    surface.addColorStop(0.55, `rgba(${pr},${pg},${pb},1)`);
    surface.addColorStop(
      1,
      `rgba(${Math.round(pr * 0.45)},${Math.round(pg * 0.45)},${Math.round(pb * 0.45)},1)`,
    );
    ctx.fillStyle = surface;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // Subtle final blur pass — pushes the backdrop just out of focus so the
  // foreground covers feel like the eye's natural focal plane.
  const blurred = document.createElement("canvas");
  blurred.width = W;
  blurred.height = H;
  const bctx = blurred.getContext("2d")!;
  bctx.filter = "blur(1px)";
  bctx.drawImage(c, 0, 0);

  const tex = new THREE.CanvasTexture(blurred);
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
  episode,
  frame,
}: {
  episode: Episode;
  frame: number;
}) {
  const items = useMemo(
    () => [...episode.items].sort((a, b) => b.rank - a.rank),
    [episode.items],
  );

  const coverPaths = useMemo(
    () => items.map((it) => staticFile(it.imagePath ?? "")),
    [items],
  );
  const covers = useTexture(coverPaths);

  // Compute fitted cover dimensions from loaded textures.
  const dims = useMemo(() => {
    return covers.map((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 16;
      t.needsUpdate = true;
      const img = t.image as { width?: number; height?: number } | undefined;
      return fitCoverDims(img?.width ?? 0, img?.height ?? 0);
    });
  }, [covers]);

  // Layout: card centers spaced by their actual widths plus a fixed gap.
  const layout = useMemo(
    () => buildLayout(dims.map((d) => d.w)),
    [dims],
  );

  const labelFontSize = useMemo(
    () => chooseLabelFontSize(items, episode.unitLabel),
    [items, episode.unitLabel],
  );
  const labels = useMemo(
    () => items.map((it) => makeLabel(it, episode.unitLabel, labelFontSize)),
    [items, episode.unitLabel, labelFontSize],
  );
  const ranks = useMemo(
    () => items.map((it) => makeRankTex(it.rank)),
    [items],
  );
  const titleTex = useMemo(
    () => makeTitleTexture(episode.title[0], episode.title[1], false),
    [episode.title],
  );
  const outroTex = useMemo(
    () => makeTitleTexture(episode.outro[0], episode.outro[1], true),
    [episode.outro],
  );

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

      <TextBoard position={[layout.titleX, TITLE_Y, 0]} texture={titleTex} />
      {items.map((item, i) => (
        <FloatingCover
          key={item.rank}
          x={layout.centers[i]}
          coverTex={covers[i]}
          labelTex={labels[i]}
          rankTex={ranks[i]}
          coverW={dims[i].w}
          coverH={dims[i].h}
        />
      ))}
      <TextBoard position={[layout.outroX, OUTRO_Y, 0]} texture={outroTex} />

      <CameraRig frame={frame} layout={layout} />
    </>
  );
}

const AUDIO_FADE_FRAMES = 90;

export const FlowSlidesComposition: React.FC<{ episode: Episode }> = ({
  episode,
}) => {
  const { width, height, durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();
  const baseVolume = episode.audioVolume ?? 0.35;
  const fadeVolume = (f: number) => {
    const fadeIn = Math.min(1, f / AUDIO_FADE_FRAMES);
    const fadeOut = Math.min(1, (durationInFrames - f) / AUDIO_FADE_FRAMES);
    return baseVolume * Math.max(0, Math.min(fadeIn, fadeOut));
  };
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
          <Scene episode={episode} frame={frame} />
        </Suspense>
      </ThreeCanvas>
      {episode.audioPath && (
        <Audio src={staticFile(episode.audioPath)} volume={fadeVolume} />
      )}
    </AbsoluteFill>
  );
};
