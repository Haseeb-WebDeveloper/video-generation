import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import { useMemo, Suspense } from "react";
import {
  AbsoluteFill,
  Audio,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Episode, EpisodeItem } from "./episode";

// ───── Geometry ─────
// One pillar per item. Bar width/depth fixed; height scales with value.
const BAR_W = 7.0;
const BAR_D = 7.0;
const MIN_BAR_H = 8;
const MAX_BAR_H = 22;

// X distance between bar centers. Bigger = more breathing room, longer pan.
// Tuned with FOV/CAM_DIST so only ~2.5–3 bars are visible at once — the
// camera frames the focused bar with a hint of the previous and next on the
// left/right edges, matching how the reference video composes each beat.
const SPACING_X = 11.5;

// Disc (logo badge) sitting on top of the pillar. DISC_OVERLAP = how much
// of the disc bottom dips into the bar top (price-tag look from the
// reference). 0 = flush, positive = submerged.
const DISC_R = 3.6;
const DISC_OVERLAP = 0.8;

// Nameplate banner mounted near the top of the bar's front face. Tall
// enough to fit two lines of text at the same size as a one-line nameplate
// so visual scale is consistent across short and long company names.
//
// Width and top offset are tuned so the maroon banner sits with a small
// equal padding (≈0.2 units) from the bar's left, right, and top edges —
// just enough breathing room that anti-aliasing doesn't bleed into the
// cream bar, while still reading as edge-to-edge.
const NAMEPLATE_PAD = 0.2;
const NAMEPLATE_W = BAR_W - NAMEPLATE_PAD * 2; // 6.6 on a 7.0 bar
const NAMEPLATE_H = 1.85;
const NAMEPLATE_FROM_TOP = NAMEPLATE_PAD + NAMEPLATE_H / 2; // top edge sits NAMEPLATE_PAD below bar top

// Value text plane (just below the nameplate).
const VALUE_PLANE_W = 5.2;
const VALUE_PLANE_H = 1.9;
const VALUE_FROM_NAMEPLATE = 1.0;

// Flagpole + flag. Pole is short and sits ON the top of the bar, sticking
// up just enough to hang the flag at bar-top level (matches the reference,
// where the flag floats next to the upper-front corner of the pillar).
const POLE_H = 2.2;
const POLE_R = 0.05;
const FLAG_W = 1.7;
const FLAG_H = 1.1;

// Camera framing. The pan is one continuous sweep from titleX to outroX.
// Camera Y tracks the CURRENT bar top so the disc + nameplate stay in frame
// even as bars get taller. CAM_DIST is the constant Z standoff. K_LOOK is
// how far below bar-top the camera aims (so the disc sits in the upper half).
// CAM_Y_LIFT is how much higher than lookAt the camera sits (gives a slight
// downward gaze, like a person walking past a row of pedestals).
const FOV = 34;
const CAM_DIST = 30;
const K_LOOK = 2.0;
const CAM_Y_LIFT = 1.8;

// Title boards sit beyond the first/last bar in X. The pan flows past them
// continuously, so they're far enough out that the camera has settled on a
// clean view by the time it reaches them — and importantly, the closest
// bar is fully out of frame when the camera holds on the title board.
const TITLE_DROP_X = -24;
const OUTRO_DROP_X = 24;
const TITLE_PLANE_W = 16;
const TITLE_PLANE_H = TITLE_PLANE_W / 2;

// ───── Palette ─────
const BAR_COLOR = "#e6dcc2"; // cream/beige pillar
const BAR_COLOR_DARK = "#bfb593"; // shadow side tint via lighting, not material
const NAMEPLATE_COLOR = "#3a1f23"; // deep maroon
const VALUE_COLOR = "#7c1c1c"; // dark blood red
const FLOOR_COLOR = "#8e8c87";
const FLOOR_TILE_LINE = "#787671";
// Back wall — same gray family as the floor, slightly lighter so the floor
// reads as the foreground surface and the wall fades back. Tile lines a
// touch darker than the wall fill so the pattern is visible without being
// noisy.
const WALL_COLOR = "#a3a098";
const WALL_TILE_LINE = "#8a8780";

// Bar X helper — index 0 sits leftmost; sorted so the smallest pillar is first
// and the tallest is last (ascending reveal).
const barX = (i: number, n: number) =>
  i * SPACING_X - ((n - 1) * SPACING_X) / 2;

function formatValueFull(
  m: number,
  format: "compact" | "raw" = "compact",
): string {
  if (format === "raw") return `${m.toLocaleString("en-US")}`;
  if (m >= 1000) return `$ ${(m / 1000).toFixed(1)} B`;
  return `$ ${m.toFixed(0)} M`;
}

type Vec3 = [number, number, number];
type FocusPose = { camPos: Vec3; lookAt: Vec3 };

// ───── Pacing (60fps) ─────
// One continuous sweep: hold on title → smooth pan past every bar → hold on
// outro. No per-bar dwell; the camera glides past at constant velocity, with
// gentle ease in/out at the very start and end of the pan.
const HOLD_INTRO = 120; // ~2s on the title board
const HOLD_OUTRO = 140; // ~2.3s on the outro board
const PER_ITEM_FRAMES = 200; // ~3.3s of pan time per bar — slower glide so the viewer can read each one

export function totalFrames(items: EpisodeItem[]): number {
  return HOLD_INTRO + items.length * PER_ITEM_FRAMES + HOLD_OUTRO;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function clamp01(t: number) {
  return Math.max(0, Math.min(1, t));
}
function smoothstep(t: number) {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

// Soft ease near the very ends of the pan so the camera doesn't jolt when
// it transitions between hold and pan. Most of the pan stays linear so the
// per-bar velocity is constant — that's what reads as "seamless flow" rather
// than stop-and-go.
function panEase(t: number): number {
  const RAMP = 0.1; // fraction of pan duration spent ramping up/down
  if (t < RAMP) {
    const u = t / RAMP;
    return 0.5 * RAMP * smoothstep(u);
  }
  if (t > 1 - RAMP) {
    const u = (t - (1 - RAMP)) / RAMP;
    return 1 - 0.5 * RAMP * (1 - smoothstep(u));
  }
  return t;
}

// ───── Per-episode runtime ─────
type SortedItem = EpisodeItem & { _barH: number };

type EpisodeRuntime = {
  items: SortedItem[];
  N: number;
  titleX: number;
  outroX: number;
  panFrames: number;
};

function buildRuntime(episode: Episode): EpisodeRuntime {
  // Sort ascending by value: smallest bar first (left), tallest last (right).
  const sorted = [...episode.items].sort((a, b) => a.value - b.value);
  const maxV = Math.max(...sorted.map((it) => it.value));
  const minV = Math.min(...sorted.map((it) => it.value));
  const items: SortedItem[] = sorted.map((it) => {
    // Height proportional to value, with a floor so even the smallest bar
    // reads as a real pillar. Use sqrt so dynamic range doesn't crush small
    // values when one item dwarfs the rest (e.g. Walmart vs the field).
    const t =
      maxV === minV
        ? 1
        : Math.sqrt((it.value - minV) / (maxV - minV)) * 0.85 + 0.15;
    const _barH = MIN_BAR_H + t * (MAX_BAR_H - MIN_BAR_H);
    return { ...it, _barH };
  });
  const N = items.length;
  const titleX = barX(0, N) + TITLE_DROP_X;
  const outroX = barX(N - 1, N) + OUTRO_DROP_X;

  return {
    items,
    N,
    titleX,
    outroX,
    panFrames: N * PER_ITEM_FRAMES,
  };
}

// What "height" does the camera see at world X? Used so the camera Y can
// track the current bar top in real time. Inside the bar row this is a
// smooth blend of the two nearest bar heights. Outside the row (before the
// first bar or after the last) it eases toward TITLE_VIEW_H so the title /
// outro boards sit at a sensible camera framing.
const TITLE_VIEW_H = MIN_BAR_H + 1; // pretend-height for the title region
const TITLE_RAMP_X = 8; // distance over which we ease from title region into bar row

function heightAtX(x: number, runtime: EpisodeRuntime): number {
  const { items, N } = runtime;
  const x0 = barX(0, N);
  const xN = barX(N - 1, N);

  if (x <= x0 - TITLE_RAMP_X) return TITLE_VIEW_H;
  if (x >= xN + TITLE_RAMP_X) return TITLE_VIEW_H;
  if (x < x0) {
    const t = (x - (x0 - TITLE_RAMP_X)) / TITLE_RAMP_X;
    return lerp(TITLE_VIEW_H, items[0]._barH, smoothstep(t));
  }
  if (x > xN) {
    const t = (x - xN) / TITLE_RAMP_X;
    return lerp(items[N - 1]._barH, TITLE_VIEW_H, smoothstep(t));
  }
  const idx = (x - x0) / SPACING_X;
  const i0 = Math.max(0, Math.min(N - 2, Math.floor(idx)));
  const f = smoothstep(idx - i0);
  return lerp(items[i0]._barH, items[i0 + 1]._barH, f);
}

function camPoseAt(x: number, runtime: EpisodeRuntime): FocusPose {
  const h = heightAtX(x, runtime);
  const lookY = h - K_LOOK;
  const camY = lookY + CAM_Y_LIFT;
  return {
    camPos: [x, camY, CAM_DIST],
    lookAt: [x, lookY, 0],
  };
}

function CameraRig({
  frame,
  runtime,
}: {
  frame: number;
  runtime: EpisodeRuntime;
}) {
  const camera = useThree((s) => s.camera);

  // Three phases: hold on title, continuous pan, hold on outro. The pan is
  // panEase'd so the velocity ramps up smoothly off the title and decelerates
  // gently into the outro — but is constant for the bulk of the row.
  let x: number;
  if (frame < HOLD_INTRO) {
    x = runtime.titleX;
  } else if (frame < HOLD_INTRO + runtime.panFrames) {
    const tRaw = (frame - HOLD_INTRO) / runtime.panFrames;
    const t = panEase(clamp01(tRaw));
    x = lerp(runtime.titleX, runtime.outroX, t);
  } else {
    x = runtime.outroX;
  }

  const pose = camPoseAt(x, runtime);
  let pos = pose.camPos;
  const look = pose.lookAt;

  // Subtle handheld-style sway, kept very small so the pan still reads as
  // smooth tracked motion rather than wobble.
  const time = frame / 60;
  pos = [
    pos[0] + Math.sin(time * 0.5) * 0.04,
    pos[1] + Math.cos(time * 0.45) * 0.03,
    pos[2] + Math.sin(time * 0.35) * 0.025,
  ];

  camera.position.set(pos[0], pos[1], pos[2]);
  camera.lookAt(look[0], look[1], look[2]);
  camera.updateProjectionMatrix();
  return null;
}

// ───── Texture builders ─────
const FONT_SERIF =
  "'Times New Roman', Georgia, 'Cambria', Cochin, serif";
const FONT_SANS =
  "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

function makeNameplateTex(title: string): THREE.CanvasTexture {
  const W = 1024;
  const H = 340;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;

  // Maroon banner with a faint inner gradient for depth.
  const grd = ctx.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, "#4a2a30");
  grd.addColorStop(0.5, NAMEPLATE_COLOR);
  grd.addColorStop(1, "#2c1418");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);

  // Soft top highlight line.
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(0, 0, W, 4);

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  // Pick layout: prefer single line at base size, otherwise wrap to 2 lines
  // at the same size. Only shrink the size as a last resort (very long
  // single words). This keeps text visually consistent across bars instead
  // of squishing one long name into tiny text.
  const BASE_SIZE = 130;
  const MAX_W = W * 0.92;
  const lines = layoutNameplate(ctx, title, BASE_SIZE, MAX_W);

  ctx.fillStyle = "#fbf2dc";
  const lineSize = lines[0].size;
  const lineH = lineSize * 1.12;
  const blockH = lines.length * lineH;
  const topY = (H - blockH) / 2 + lineSize;
  ctx.font = `700 ${lineSize}px ${FONT_SERIF}`;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i].text, W / 2, topY + i * lineH);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

function layoutNameplate(
  ctx: CanvasRenderingContext2D,
  text: string,
  baseSize: number,
  maxW: number,
): { text: string; size: number }[] {
  ctx.font = `700 ${baseSize}px ${FONT_SERIF}`;
  if (ctx.measureText(text).width <= maxW) {
    return [{ text, size: baseSize }];
  }
  const words = text.split(" ");
  if (words.length >= 2) {
    // Pick the split that minimizes the longer line — gives the most
    // balanced 2-line layout.
    let best: { l1: string; l2: string; widest: number } | null = null;
    for (let split = 1; split < words.length; split++) {
      const l1 = words.slice(0, split).join(" ");
      const l2 = words.slice(split).join(" ");
      const w = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width);
      if (best === null || w < best.widest) {
        best = { l1, l2, widest: w };
      }
    }
    if (best && best.widest <= maxW) {
      return [
        { text: best.l1, size: baseSize },
        { text: best.l2, size: baseSize },
      ];
    }
    // 2 lines at baseSize don't fit either — shrink size for the chosen split.
    if (best) {
      for (let size = baseSize - 6; size >= Math.round(baseSize * 0.65); size -= 4) {
        ctx.font = `700 ${size}px ${FONT_SERIF}`;
        const w = Math.max(
          ctx.measureText(best.l1).width,
          ctx.measureText(best.l2).width,
        );
        if (w <= maxW) {
          return [
            { text: best.l1, size },
            { text: best.l2, size },
          ];
        }
      }
    }
  }
  // Single very long word — shrink single line.
  for (let size = baseSize - 6; size >= Math.round(baseSize * 0.55); size -= 4) {
    ctx.font = `700 ${size}px ${FONT_SERIF}`;
    if (ctx.measureText(text).width <= maxW) {
      return [{ text, size }];
    }
  }
  return [{ text, size: Math.round(baseSize * 0.55) }];
}

function makeValueTex(text: string): THREE.CanvasTexture {
  const W = 1024;
  const H = 384;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  let size = Math.round(H * 0.62);
  ctx.font = `700 ${size}px ${FONT_SERIF}`;
  while (ctx.measureText(text).width > W * 0.92 && size > Math.round(H * 0.3)) {
    size -= 6;
    ctx.font = `700 ${size}px ${FONT_SERIF}`;
  }

  // Drop shadow for depth against the pillar face.
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = VALUE_COLOR;
  ctx.fillText(text, W / 2, H / 2);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

function makeDiscTex(coverImg: HTMLImageElement | null): THREE.CanvasTexture {
  const S = 1024;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, S, S);

  const cx = S / 2;
  const cy = S / 2;
  // Soft outer halo for premium depth — no hard ring/border. The halo lives
  // outside the disc face so the face itself reads as a clean white circle.
  const haloR = S * 0.495;
  const halo = ctx.createRadialGradient(cx, cy, haloR * 0.92, cx, cy, haloR);
  halo.addColorStop(0, "rgba(0,0,0,0)");
  halo.addColorStop(0.6, "rgba(20,24,32,0.05)");
  halo.addColorStop(1, "rgba(20,24,32,0.0)");
  ctx.beginPath();
  ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
  ctx.fillStyle = halo;
  ctx.fill();

  // Pure white disc face — no border, no ring.
  const faceR = S * 0.48;
  ctx.beginPath();
  ctx.arc(cx, cy, faceR, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();

  // Very subtle inner gradient for a hint of dimension, not a vignette.
  const grd = ctx.createRadialGradient(cx - 40, cy - 60, 20, cx, cy, faceR);
  grd.addColorStop(0, "rgba(255,255,255,0.0)");
  grd.addColorStop(0.85, "rgba(0,0,0,0.0)");
  grd.addColorStop(1, "rgba(0,0,0,0.06)");
  ctx.beginPath();
  ctx.arc(cx, cy, faceR, 0, Math.PI * 2);
  ctx.fillStyle = grd;
  ctx.fill();

  // Logo clipped inside the face with generous margin.
  if (coverImg && coverImg.width > 0) {
    const margin = faceR * 0.20;
    const fitR = faceR - margin;
    const aspect = coverImg.width / coverImg.height;
    let drawW = fitR * 2;
    let drawH = fitR * 2;
    if (aspect >= 1) drawH = drawW / aspect;
    else drawW = drawH * aspect;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, faceR - 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(coverImg, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
    ctx.restore();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

function makeTitleTex(line1: string, line2: string): THREE.CanvasTexture {
  const W = 2048;
  const H = 1024;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);

  // Soft drop shadow rectangle for legibility against sky.
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 8;

  let s1 = Math.round(H * 0.18);
  ctx.font = `800 ${s1}px ${FONT_SERIF}`;
  while (ctx.measureText(line1).width > W * 0.92 && s1 > Math.round(H * 0.08)) {
    s1 -= 4;
    ctx.font = `800 ${s1}px ${FONT_SERIF}`;
  }

  let s2 = Math.round(H * 0.085);
  ctx.font = `500 ${s2}px ${FONT_SANS}`;
  while (ctx.measureText(line2).width > W * 0.92 && s2 > Math.round(H * 0.04)) {
    s2 -= 2;
    ctx.font = `500 ${s2}px ${FONT_SANS}`;
  }

  const gap = H * 0.05;
  const blockH = s1 + gap + s2;
  const topY = (H - blockH) / 2;

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = "#fbf2dc";
  ctx.font = `800 ${s1}px ${FONT_SERIF}`;
  ctx.fillText(line1, W / 2, topY + s1);

  ctx.fillStyle = "rgba(251, 242, 220, 0.86)";
  ctx.font = `500 ${s2}px ${FONT_SANS}`;
  ctx.fillText(line2, W / 2, topY + s1 + gap + s2);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

// ───── Backdrop (back wall) ─────
function makeWallTex(): THREE.CanvasTexture {
  const W = 1024;
  const H = 1024;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = WALL_COLOR;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = WALL_TILE_LINE;
  ctx.lineWidth = 4;
  const STEP = 128;
  for (let i = 0; i <= W; i += STEP) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, H);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(W, i);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // ~6 world-unit tiles on the wall — a touch larger than the floor's so
  // the perspective scale of the two surfaces reads as different surfaces,
  // not one continuous texture.
  tex.repeat.set(20, 4);
  tex.anisotropy = 16;
  return tex;
}

function makeFloorTex(): THREE.CanvasTexture {
  const W = 1024;
  const H = 1024;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = FLOOR_COLOR;
  ctx.fillRect(0, 0, W, H);
  // Tile grid.
  ctx.strokeStyle = FLOOR_TILE_LINE;
  ctx.lineWidth = 3;
  const STEP = 128;
  for (let i = 0; i <= W; i += STEP) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, H);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(W, i);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(40, 40);
  tex.anisotropy = 16;
  return tex;
}

// ───── Components ─────
function Backdrop() {
  const wall = useMemo(() => makeWallTex(), []);
  return (
    <mesh position={[0, 28, -180]}>
      <planeGeometry args={[600, 110]} />
      <meshStandardMaterial
        map={wall}
        roughness={0.95}
        metalness={0}
        color="#b6b3aa"
      />
    </mesh>
  );
}

function Floor() {
  const floor = useMemo(() => makeFloorTex(), []);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
      <planeGeometry args={[1200, 1200]} />
      <meshStandardMaterial
        map={floor}
        roughness={0.95}
        metalness={0}
        color="#a4a29c"
      />
    </mesh>
  );
}

function Flag({
  flagTex,
  baseX,
  baseY,
  z,
  frame,
  index,
}: {
  flagTex: THREE.Texture | null;
  baseX: number;
  baseY: number;
  z: number;
  frame: number;
  index: number;
}) {

  // Subtle wave: rotate the flag plane on Y around the pole, plus a small Z tilt.
  const t = frame / 60 + index * 0.7;
  const sway = Math.sin(t * 1.6) * 0.18;
  const tilt = Math.sin(t * 1.2 + 1) * 0.08;

  return (
    <group position={[baseX, baseY, z]}>
      {/* Pole */}
      <mesh position={[0, POLE_H / 2, 0]}>
        <cylinderGeometry args={[POLE_R, POLE_R, POLE_H, 12]} />
        <meshStandardMaterial color="#c9b274" metalness={0.6} roughness={0.4} />
      </mesh>
      {/* Pole cap */}
      <mesh position={[0, POLE_H + 0.08, 0]}>
        <sphereGeometry args={[POLE_R * 1.8, 12, 12]} />
        <meshStandardMaterial color="#e6cf86" metalness={0.7} roughness={0.3} />
      </mesh>
      {/* Flag — pivot at left edge so it rotates around the pole */}
      {flagTex && (
        <group position={[0, POLE_H - FLAG_H * 0.6, 0]} rotation={[0, sway, tilt]}>
          <mesh position={[FLAG_W / 2, 0, 0]}>
            <planeGeometry args={[FLAG_W, FLAG_H, 16, 6]} />
            <meshStandardMaterial
              map={flagTex}
              side={THREE.DoubleSide}
              roughness={0.7}
              metalness={0}
            />
          </mesh>
        </group>
      )}
    </group>
  );
}

function Pillar({
  index,
  N,
  item,
  episode,
  discTex,
  flagTex,
  frame,
}: {
  index: number;
  N: number;
  item: SortedItem;
  episode: Episode;
  discTex: THREE.Texture;
  flagTex: THREE.Texture | null;
  frame: number;
}) {
  const x = barX(index, N);
  const h = item._barH;

  const nameplateTex = useMemo(
    () => makeNameplateTex(item.title),
    [item.title],
  );
  const valueTex = useMemo(
    () =>
      makeValueTex(formatValueFull(item.value, episode.valueFormat ?? "compact")),
    [item.value, episode.valueFormat],
  );

  // Front face is at z = +BAR_D/2 ; mount nameplate/value slightly in front.
  const FRONT_Z = BAR_D / 2 + 0.015;

  const nameplateY = h - NAMEPLATE_FROM_TOP;
  const valueY = nameplateY - NAMEPLATE_H / 2 - VALUE_FROM_NAMEPLATE - VALUE_PLANE_H / 2 + 0.4;

  // Disc sits on top of the pillar; DISC_OVERLAP submerges its bottom edge
  // slightly into the bar top for the price-tag look in the reference.
  const discY = h + DISC_R - DISC_OVERLAP;

  return (
    <group position={[x, 0, 0]}>
      {/* Pillar block — pivot at base so we can scale Y from the floor up. */}
      <mesh position={[0, h / 2, 0]}>
        <boxGeometry args={[BAR_W, h, BAR_D]} />
        <meshStandardMaterial
          color={BAR_COLOR}
          roughness={0.9}
          metalness={0.02}
        />
      </mesh>

      {/* Subtle top cap shading — slightly darker plane on top to fake AO */}
      <mesh position={[0, h + 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[BAR_W * 0.999, BAR_D * 0.999]} />
        <meshStandardMaterial color={BAR_COLOR_DARK} roughness={1} />
      </mesh>

      {/* Nameplate */}
      <mesh position={[0, nameplateY, FRONT_Z]}>
        <planeGeometry args={[NAMEPLATE_W, NAMEPLATE_H]} />
        <meshBasicMaterial map={nameplateTex} transparent depthWrite={false} />
      </mesh>

      {/* Value */}
      <mesh position={[0, valueY, FRONT_Z]}>
        <planeGeometry args={[VALUE_PLANE_W, VALUE_PLANE_H]} />
        <meshBasicMaterial map={valueTex} transparent depthWrite={false} />
      </mesh>

      {/* Logo disc — billboard-ish: slight forward lean so it reads from the
          camera angle. Z slightly forward of bar center. */}
      <group position={[0, discY, 0.4]} rotation={[0, 0, 0]}>
        <mesh>
          <circleGeometry args={[DISC_R, 64]} />
          <meshStandardMaterial
            map={discTex}
            transparent
            roughness={0.55}
            metalness={0.05}
          />
        </mesh>
      </group>

      {/* Flag — pole planted in the top-right-front corner of the pillar so
          it pokes up just above bar-top level, exactly how the reference
          mounts each flag. */}
      <Flag
        flagTex={flagTex}
        baseX={BAR_W / 2 - 0.4}
        baseY={h}
        z={BAR_D / 2 - 0.4}
        frame={frame}
        index={index}
      />
    </group>
  );
}

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

// Title/outro boards are kept OUTSIDE the cover-loading Suspense so the
// intro hold (frame 0+) renders the title board even on the very first
// frame, before any logo textures have decoded.
function TitleBoards({
  episode,
  runtime,
}: {
  episode: Episode;
  runtime: EpisodeRuntime;
}) {
  const titleTex = useMemo(
    () => makeTitleTex(episode.title[0], episode.title[1]),
    [episode.title],
  );
  const outroTex = useMemo(
    () => makeTitleTex(episode.outro[0], episode.outro[1]),
    [episode.outro],
  );
  return (
    <>
      <TextBoard
        position={[runtime.titleX, TITLE_VIEW_H - 0.5, 0]}
        texture={titleTex}
      />
      <TextBoard
        position={[runtime.outroX, TITLE_VIEW_H - 0.5, 0]}
        texture={outroTex}
      />
    </>
  );
}

function BarRow({
  frame,
  episode,
  runtime,
}: {
  frame: number;
  episode: Episode;
  runtime: EpisodeRuntime;
}) {
  // Load all cover images. useTexture suspends until all are loaded.
  const coverPaths = useMemo(
    () => runtime.items.map((it) => staticFile(it.imagePath ?? "")),
    [runtime.items],
  );
  const covers = useTexture(coverPaths);

  // Build a disc texture per item — composite logo into a circular badge.
  const discTexs = useMemo(() => {
    return covers.map((t) => {
      const img = (t.image ?? null) as HTMLImageElement | null;
      return makeDiscTex(img);
    });
  }, [covers]);

  // Flag textures — load via plain TextureLoader (non-suspending). If a flag
  // PNG is missing or fails, the corresponding entry stays null and the flag
  // simply isn't rendered.
  const flagTexs = useMemo(() => {
    const loader = new THREE.TextureLoader();
    return runtime.items.map((it) => {
      if (!it.country) return null;
      const url = staticFile(`flags/${it.country.toLowerCase()}.png`);
      const tex = loader.load(
        url,
        undefined,
        undefined,
        () => {
          // swallow errors — flag just won't show
        },
      );
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 16;
      return tex;
    });
  }, [runtime.items]);

  return (
    <>
      {runtime.items.map((item, i) => (
        <Pillar
          key={item.rank}
          index={i}
          N={runtime.N}
          item={item}
          episode={episode}
          discTex={discTexs[i]}
          flagTex={flagTexs[i]}
          frame={frame}
        />
      ))}
    </>
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
      <color attach="background" args={[WALL_COLOR]} />
      <Backdrop />
      <Floor />

      <ambientLight intensity={0.9} color="#ffffff" />
      <directionalLight
        position={[-30, 50, 25]}
        intensity={0.85}
        color="#fff5e0"
      />
      <directionalLight
        position={[20, 10, 15]}
        intensity={0.25}
        color="#e2dccd"
      />

      <TitleBoards episode={episode} runtime={runtime} />
      <Suspense fallback={null}>
        <BarRow frame={frame} episode={episode} runtime={runtime} />
      </Suspense>
    </>
  );
}

const AUDIO_FADE_FRAMES = 90;

export const BarSlidesComposition: React.FC<{ episode: Episode }> = ({
  episode,
}) => {
  const { width, height, durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();
  const runtime = useMemo(() => buildRuntime(episode), [episode]);
  const baseVolume = episode.audioVolume ?? 0.35;
  const fadeVolume = (f: number) => {
    const fadeIn = Math.min(1, f / AUDIO_FADE_FRAMES);
    const fadeOut = Math.min(1, (durationInFrames - f) / AUDIO_FADE_FRAMES);
    return baseVolume * Math.max(0, Math.min(fadeIn, fadeOut));
  };
  return (
    <AbsoluteFill style={{ background: WALL_COLOR }}>
      <ThreeCanvas
        width={width}
        height={height}
        camera={{ fov: FOV, near: 0.1, far: 800 }}
        dpr={1}
        gl={{
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.05,
          antialias: true,
          powerPreference: "high-performance",
        }}
      >
        <Suspense fallback={null}>
          <Scene frame={frame} episode={episode} runtime={runtime} />
        </Suspense>
        <CameraRig frame={frame} runtime={runtime} />
      </ThreeCanvas>
      {episode.audioPath && (
        <Audio src={staticFile(episode.audioPath)} volume={fadeVolume} />
      )}
    </AbsoluteFill>
  );
};
