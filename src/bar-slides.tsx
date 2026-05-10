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

// Title boards sit beyond the first/last bar in X. The camera covers these
// gaps in their own dedicated phases (APPROACH/EXIT) at much higher than
// per-bar speed, so generous spacing reads as "breathing room" rather than
// "long boring travel."
const TITLE_DROP_X = -22;
const OUTRO_DROP_X = 22;
// Title/outro board size in world units. Bigger plane = bigger text on
// screen (text scales with the plane since the canvas texture is fixed).
const TITLE_PLANE_W = 20;
const TITLE_PLANE_H = TITLE_PLANE_W / 2;

// ───── Palette ─────
// Channel branding: deep space navy background, white sans-serif text, warm
// orange highlight, hint of cosmic purple. Cream pillars are kept because
// they contrast cleanly with the navy and read as physical monuments — the
// scene's "ranking podium" metaphor.
const BAR_COLOR = "#efe7d1"; // ivory pillar — slightly cleaner than the previous warm cream
const BAR_COLOR_DARK = "#cfc6a8"; // top-cap shading
const NAMEPLATE_COLOR = "#0e1430"; // deep brand navy — matches wall/floor
const NAMEPLATE_TEXT = "#ffffff"; // pure white text on the nameplate
const VALUE_COLOR = "#0e1430"; // deep brand navy — same as nameplate, reads as ink on the cream pillar
// Soft neutral-gray floor — slightly lighter and cooler than before, with
// tile lines pulled close to the base color so the grid reads as a faint
// perspective hint rather than a sharp pattern.
const FLOOR_COLOR = "#433c5c";
const FLOOR_TILE_LINE = "#6a6380";
// Back wall: same space navy, painted with a sparse starfield so the
// backdrop reads as "cosmic" instead of "warehouse." Stars are baked into
// the wall texture (see makeWallTex).
const WALL_COLOR = "#0a0f24";
const STAR_COLOR = "#ffffff";
const STAR_TINT = "#b6b4ff"; // bluish halo on the brightest stars
const TITLE_TEXT = "#ffffff"; // primary title color
const TITLE_TEXT_SOFT = "rgba(255, 255, 255, 0.86)"; // subtitle / line 2

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
// Five phases: intro hold → fast approach → constant-velocity bar pan →
// fast exit → outro hold.
//
// The bar pan stays at a CONSTANT velocity (V_BAR = SPACING_X/PER_ITEM_FRAMES)
// so every bar gets identical on-screen time — each one reads cleanly.
// APPROACH/EXIT are separate Hermite curves that traverse the title/outro
// gaps in a SHORT window — peak velocity inside them is several × V_BAR,
// which is what reads as "snappy intro/outro." The Hermite math links
// approach end velocity exactly to V_BAR (and exit start velocity to V_BAR)
// so there are no velocity jolts at the phase seams.
const HOLD_INTRO = 75; // ~1.25s static title hold — long enough to read the title
const APPROACH_FRAMES = 180; // ~3.0s — relaxed dive from titleX into first bar
const PER_ITEM_FRAMES = 200; // ~3.3s per bar at constant velocity
const EXIT_FRAMES = 180; // ~3.0s — mirror of approach, dive away from last bar
const HOLD_OUTRO = 90; // ~1.5s static outro hold

export function totalFrames(items: EpisodeItem[]): number {
  // (N - 1) bar-to-bar transitions at PER_ITEM_FRAMES each, framed by the
  // approach and exit phases on either side.
  const barPanFrames = Math.max(0, items.length - 1) * PER_ITEM_FRAMES;
  return (
    HOLD_INTRO + APPROACH_FRAMES + barPanFrames + EXIT_FRAMES + HOLD_OUTRO
  );
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

// Bar-pan velocity in world units per frame. Constant across the bar row so
// each bar gets identical on-screen time. Approach/exit are derived to meet
// this velocity exactly at the row's first/last bar — no kicks at the seams.
const V_BAR = SPACING_X / PER_ITEM_FRAMES;

// Hermite cubic from rest at offset 0 to V_BAR at offset D over `frames`.
// Used by the APPROACH phase: camera starts still at titleX (end of intro
// hold) and matches the constant bar-pan velocity exactly when it reaches
// the first bar, with peak velocity in the middle of the curve being many
// × V_BAR — the visible "snappy dive in."
function hermiteAccelerate(u: number, D: number, frames: number): number {
  // p(u) = h01(u)*p1 + h11(u)*v1_norm
  //      = smoothstep(u)*D + (u^3 - u^2)*V_BAR*frames
  return smoothstep(u) * D + (u * u * u - u * u) * V_BAR * frames;
}

// Mirror of hermiteAccelerate: starts at V_BAR (matching end of bar pan),
// ends at rest at offset D over `frames`. Used by the EXIT phase.
function hermiteDecelerate(u: number, D: number, frames: number): number {
  // p(u) = h10(u)*v0_norm + h01(u)*p1
  //      = (u^3 - 2u^2 + u)*V_BAR*frames + smoothstep(u)*D
  return (u * u * u - 2 * u * u + u) * V_BAR * frames + smoothstep(u) * D;
}

// ───── Per-episode runtime ─────
type SortedItem = EpisodeItem & { _barH: number };

type EpisodeRuntime = {
  items: SortedItem[];
  N: number;
  titleX: number;
  outroX: number;
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
  };
}

// What "height" does the camera see at world X? Used so the camera Y can
// track the current bar top in real time. Inside the bar row this is a
// smooth blend of the two nearest bar heights. Outside the row, the camera
// inherits the height of the nearest bar so the intro/outro hold uses the
// SAME framing the camera will have when it reaches the first/last bar —
// no abrupt Y drop between hold and pan.
function heightAtX(x: number, runtime: EpisodeRuntime): number {
  const { items, N } = runtime;
  const x0 = barX(0, N);
  const xN = barX(N - 1, N);

  if (x <= x0) return items[0]._barH;
  if (x >= xN) return items[N - 1]._barH;
  const idx = (x - x0) / SPACING_X;
  const i0 = Math.max(0, Math.min(N - 2, Math.floor(idx)));
  const f = smoothstep(idx - i0);
  return lerp(items[i0]._barH, items[i0 + 1]._barH, f);
}

// How far above the camera's lookAt the title/outro board centers sit.
// Tuned so the board reads in the upper-middle of the frame, the same
// position a bar's nameplate would occupy.
const TITLE_OFFSET_FROM_LOOK = 1.5;

// Camera dolly applied during the (now short) intro/outro holds so neither
// feels static. Smaller magnitudes than before because the holds are only
// ~0.5–0.8s — the bulk of the visual motion comes from the APPROACH/EXIT
// phases that follow the intro hold and precede the outro hold.
const HOLD_DOLLY_Z = 2.5;
const HOLD_DOLLY_Y = 0.6;

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

  const { N, titleX, outroX } = runtime;
  const x0 = barX(0, N);
  const xN = barX(N - 1, N);
  const barPanFrames = Math.max(0, N - 1) * PER_ITEM_FRAMES;
  const approachD = x0 - titleX; // > 0
  const exitD = outroX - xN; // > 0

  // Phase boundary frames.
  const fApproach = HOLD_INTRO;
  const fBarPan = fApproach + APPROACH_FRAMES;
  const fExit = fBarPan + barPanFrames;
  const fOutroHold = fExit + EXIT_FRAMES;

  let x: number;
  let dollyZ = 0;
  let dollyY = 0;
  if (frame < fApproach) {
    // Phase 1: intro hold. Subtle settle dolly (back+up → base).
    x = titleX;
    const t = smoothstep(frame / HOLD_INTRO);
    dollyZ = (1 - t) * HOLD_DOLLY_Z;
    dollyY = (1 - t) * HOLD_DOLLY_Y;
  } else if (frame < fBarPan) {
    // Phase 2: fast approach. Hermite curve ramps from rest to V_BAR exactly
    // as the camera reaches the first bar — peak velocity in the middle is
    // many × V_BAR, which is what reads as a "snappy dive in."
    const u = (frame - fApproach) / APPROACH_FRAMES;
    x = titleX + hermiteAccelerate(u, approachD, APPROACH_FRAMES);
  } else if (frame < fExit) {
    // Phase 3: constant V_BAR pan through the bar row. Each bar gets the
    // same on-screen time.
    x = x0 + V_BAR * (frame - fBarPan);
  } else if (frame < fOutroHold) {
    // Phase 4: fast exit. Mirror of approach — starts at V_BAR, decelerates
    // to rest exactly at the outro position.
    const u = (frame - fExit) / EXIT_FRAMES;
    x = xN + hermiteDecelerate(u, exitD, EXIT_FRAMES);
  } else {
    // Phase 5: outro hold. Subtle pull-back dolly (base → back+up).
    x = outroX;
    const t = smoothstep((frame - fOutroHold) / HOLD_OUTRO);
    dollyZ = t * HOLD_DOLLY_Z;
    dollyY = t * HOLD_DOLLY_Y;
  }

  const pose = camPoseAt(x, runtime);
  let pos: Vec3 = [
    pose.camPos[0],
    pose.camPos[1] + dollyY,
    pose.camPos[2] + dollyZ,
  ];
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
// Brand uses one clean sans family across all surfaces — title cards,
// nameplates, value text. Inter first (matches the channel thumbnails),
// with system-stack fallbacks for non-Inter render environments.
const FONT_SANS =
  "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
// Kept as an alias so existing references keep working without churn — the
// "serif" surfaces (nameplate, value, title) all now use the brand sans.
const FONT_SERIF = FONT_SANS;

function makeNameplateTex(title: string): THREE.CanvasTexture {
  const W = 1024;
  const H = 340;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;

  // Brand navy banner with a faint inner gradient for depth.
  const grd = ctx.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, "#1a2148");
  grd.addColorStop(0.5, NAMEPLATE_COLOR);
  grd.addColorStop(1, "#070b1c");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);

  // Soft top highlight line.
  ctx.fillStyle = "rgba(255,255,255,0.08)";
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

  ctx.fillStyle = NAMEPLATE_TEXT;
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

  // Light drop shadow for depth. Dark navy text on cream pillar already has
  // strong contrast, so the shadow is just a hint — heavier values muddied
  // the letterforms.
  ctx.shadowColor = "rgba(14, 20, 48, 0.18)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
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

  ctx.fillStyle = TITLE_TEXT;
  ctx.font = `800 ${s1}px ${FONT_SANS}`;
  ctx.fillText(line1, W / 2, topY + s1);

  ctx.fillStyle = TITLE_TEXT_SOFT;
  ctx.font = `500 ${s2}px ${FONT_SANS}`;
  ctx.fillText(line2, W / 2, topY + s1 + gap + s2);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

// ───── Backdrop (back wall) ─────
// Sparse starfield baked into a single large texture (no tiled repeat —
// stars would visibly tile and break the illusion). Subtle vertical
// gradient gives the sky a sense of depth, brighter near the horizon.
function makeWallTex(): THREE.CanvasTexture {
  const W = 4096;
  const H = 1024;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;

  // Vertical gradient: a touch lighter near the bottom (horizon glow).
  const grd = ctx.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, "#070b1c");
  grd.addColorStop(0.7, WALL_COLOR);
  grd.addColorStop(1, "#101638");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);

  // Deterministic PRNG so the starfield is identical across re-renders.
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };

  // Faint dust stars — very small, low opacity.
  for (let i = 0; i < 1200; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    const r = 0.5 + rnd() * 1.0;
    const a = 0.18 + rnd() * 0.45;
    ctx.fillStyle = `rgba(255, 255, 255, ${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Highlight stars with a soft halo — mimics the sparkles in the channel
  // logo without being literal.
  for (let i = 0; i < 60; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    const r = 1.6 + rnd() * 1.4;
    const halo = ctx.createRadialGradient(x, y, 0, x, y, r * 6);
    halo.addColorStop(0, "rgba(196, 196, 255, 0.35)");
    halo.addColorStop(1, "rgba(196, 196, 255, 0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, r * 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = STAR_COLOR;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Two or three faint nebula tints — sample from the channel logo's
  // purple-to-pink palette. Keeps the wall from feeling flat.
  const nebulaTints = ["rgba(82, 36, 134, 0.18)", "rgba(160, 80, 200, 0.10)"];
  for (let i = 0; i < 6; i++) {
    const x = rnd() * W;
    const y = H * (0.25 + rnd() * 0.5);
    const r = 220 + rnd() * 280;
    const tint = nebulaTints[i % nebulaTints.length];
    const cloud = ctx.createRadialGradient(x, y, 0, x, y, r);
    cloud.addColorStop(0, tint);
    cloud.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = cloud;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Quiet the nebula clouds with a subtle dark vignette near the very top
  // and bottom so they don't hover at the edges of the wall.
  void STAR_TINT;

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // No repeat — single big texture across the whole back wall so stars
  // don't tile visibly.
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
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
  // Tile grid — thinner than before so the floor reads as a hazy plane,
  // not a hard grid.
  ctx.strokeStyle = FLOOR_TILE_LINE;
  ctx.lineWidth = 2;
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
      <meshBasicMaterial map={wall} />
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
        roughness={0.98}
        metalness={0}
        color="#aaaaa6"
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
  // Boards sit at the camera's natural framing for the nearest bar — same
  // Y a bar's nameplate would occupy from this distance — so the cut from
  // intro hold into pan (and from pan into outro hold) involves no Y change.
  const titleBoardY =
    runtime.items[0]._barH - K_LOOK + TITLE_OFFSET_FROM_LOOK;
  const outroBoardY =
    runtime.items[runtime.N - 1]._barH - K_LOOK + TITLE_OFFSET_FROM_LOOK;
  return (
    <>
      <TextBoard
        position={[runtime.titleX, titleBoardY, 0]}
        texture={titleTex}
      />
      <TextBoard
        position={[runtime.outroX, outroBoardY, 0]}
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

      <ambientLight intensity={0.85} color="#cdd4ee" />
      {/* Cool key light tinted toward the brand navy/violet so the cream
          pillars don't read as warm sunlight against the cosmic backdrop. */}
      <directionalLight
        position={[-30, 50, 25]}
        intensity={0.95}
        color="#e8eaff"
      />
      {/* Faint warm rim light from the right — picks up the brand orange
          and prevents the back side of each pillar from going dead flat. */}
      <directionalLight
        position={[20, 10, 15]}
        intensity={0.3}
        color="#f5a64a"
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
