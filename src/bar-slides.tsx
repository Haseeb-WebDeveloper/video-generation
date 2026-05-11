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
import { loadFont } from "@remotion/google-fonts/Inter";
import { Episode, EpisodeItem } from "./episode";

// Trigger Inter load at module scope so Remotion's delayRender holds the
// render until the font is actually available. Without this, the first
// frame paints with the system sans-serif fallback because the canvas
// fillText runs before any web font has decoded.
const { fontFamily: INTER } = loadFont();

// ───── Geometry ─────
// One pillar per item. Bar width/depth fixed; height scales with value.
const BAR_W = 7.0;
const BAR_D = 7.0;
// Bar height range. Wider range = larger absolute difference between any
// two bars on screen, which is what the eye reads as "this is bigger
// than that." With a 14-unit range (8→22) a 3-unit bar-height difference
// only registered as ~17% of frame height; with the wider range below
// the same numerical gap covers ~25%, so adjacent ranks read as visibly
// different bars even when their values are close in numerical terms.
// MIN stays clear of the floor so the value text plane doesn't clip
// against it on the shortest bar.
const MIN_BAR_H = 10;
const MAX_BAR_H = 80;

// X distance between bar centers. Bigger = more breathing room, longer pan.
// Tuned with FOV/CAM_DIST so only ~2.5–3 bars are visible at once — the
// camera frames the focused bar with a hint of the previous and next on the
// left/right edges, matching how the reference video composes each beat.
const SPACING_X = 11.5;

// Cover card sitting on top of the pillar. Flat plane that displays the
// cover image AS-IS — no clipping, no halo, no white padding. The card
// width/height adapt to the cover's native aspect ratio (computed from
// the loaded texture's image dimensions) so portrait sources render
// portrait and landscape sources render landscape — never letterboxed
// into a square.
const CARD_MAX = 7.0; // both dimensions fit inside CARD_MAX × CARD_MAX
const CARD_OVERLAP = 0.6;

function fitCardDims(imgW: number, imgH: number): { w: number; h: number } {
  if (!imgW || !imgH) return { w: CARD_MAX, h: CARD_MAX };
  const aspect = imgW / imgH;
  if (aspect >= 1) return { w: CARD_MAX, h: CARD_MAX / aspect };
  return { w: CARD_MAX * aspect, h: CARD_MAX };
}

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

// Value text plane (just below the nameplate). Sized as a wide, generous
// block so the headline number + unit label have room to breathe. Aspect
// (6.0/2.25 ≈ 2.67) matches the value canvas (1024×384) so nothing
// stretches.
const VALUE_PLANE_W = 6.0;
const VALUE_PLANE_H = 2.25;
const VALUE_FROM_NAMEPLATE = 0.9;

// Flagpole + flag. Pole is short and sits ON the top of the bar, sticking
// up just enough to hang the flag at bar-top level (matches the reference,
// where the flag floats next to the upper-front corner of the pillar).
const POLE_H = 2.2;
const POLE_R = 0.05;
const FLAG_W = 1.7;
const FLAG_H = 1.1;

// Camera framing. The pan is one continuous sweep from titleX to outroX.
// Camera Y tracks the CURRENT bar top so the card + nameplate stay in frame
// even as bars get taller.
//
// LOOK_ABOVE_BAR_TOP: how far ABOVE the bar's top face the camera aims.
// Positive lifts the aim into the card area and gives the card real
// headroom in the frame — without this the cards graze the top edge.
// CAM_Y_LIFT is how much higher than lookAt the camera sits (gives a slight
// downward gaze, like a person walking past a row of pedestals).
const FOV = 34;
const CAM_DIST = 30;
const LOOK_ABOVE_BAR_TOP = 2.0;
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
const BAR_COLOR = "#d9d9d8"; // deep blue — front and back face of the pillar
const BAR_SIDE_COLOR = "#ffffff"; // warm cream — left and right faces (and top cap)
const BAR_COLOR_DARK = "#e8dfb5"; // slightly darker cream — top-cap shading, sits between BAR_SIDE_COLOR and BAR_COLOR for soft AO
const NAMEPLATE_COLOR = "#15015b"; // deep brand navy — matches wall/floor
const NAMEPLATE_TEXT = "#ffffff"; // pure white text on the nameplate
// Dark ink on the light pillar front. Matches the nameplate background so
// the title nameplate and the numeric value read as the same family of
// marks, just at different scales.
const VALUE_COLOR = "#000000";
// Fallback color shown under the canvas while bg-2.jpg loads, and at any
// frame edge the scene background quad doesn't cover. Match the deep
// navy of the chosen backdrop so the transition is invisible if it ever
// flashes.
const WALL_COLOR = "#0a0f24";
// Dark ink for the intro/outro boards — matches the nameplate + value
// palette so every text surface in the scene reads as the same family.
const TITLE_TEXT = "#15015b"; // primary title color (line 1)
const TITLE_TEXT_SOFT = "rgba(21, 1, 91, 0.86)"; // subtitle / line 2 — same hue at 86% opacity

// Bar X helper — index 0 sits leftmost; sorted so the smallest pillar is first
// and the tallest is last (ascending reveal).
const barX = (i: number, n: number) =>
  i * SPACING_X - ((n - 1) * SPACING_X) / 2;

// Format the bare numeric value (no unit). The unit label is rendered as a
// separate line by makeValueTex.
function formatValueFull(
  m: number,
  format: "compact" | "raw" = "compact",
): string {
  if (format === "raw") return m.toLocaleString("en-US");
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

// Bar height scales by log10 of value, so every doubling of the value
// produces a constant height increment ("doubles look doubled" in log
// space). Pure linear scaling is mathematically impossible across the
// real-world dynamic range we see in these episodes — e.g. mosquito vs
// shark is 72,500× apart, so a true-linear mosquito bar would be
// 72,500× taller than shark's, which can't share a frame. Log is the
// strongest visually-honest scaling that fits.
//
// A small per-rank perturbation (TIE_BREAK) prevents same-value items
// (e.g. lion + buffalo both at 200) from rendering as identical-height
// duplicate bars. The perturbation is too small to disrupt log
// proportionality between unequal values.
const TIE_BREAK = 0.02;

function buildRuntime(episode: Episode): EpisodeRuntime {
  // Sort ascending by value: smallest bar first (left), tallest last (right).
  const sorted = [...episode.items].sort((a, b) => a.value - b.value);
  const N = sorted.length;
  const safeMin = Math.max(1, sorted[0]?.value ?? 1);
  const safeMax = Math.max(1, sorted[N - 1]?.value ?? 1);
  const logMin = Math.log10(safeMin);
  const logMax = Math.log10(safeMax);
  const logRange = Math.max(logMax - logMin, 0.001);

  const items: SortedItem[] = sorted.map((it, i) => {
    const tLog = (Math.log10(Math.max(1, it.value)) - logMin) / logRange;
    const tieBreaker = N <= 1 ? 0 : (i / (N - 1)) * TIE_BREAK;
    const t = clamp01(tLog * (1 - TIE_BREAK) + tieBreaker);
    const _barH = MIN_BAR_H + t * (MAX_BAR_H - MIN_BAR_H);
    return { ...it, _barH };
  });
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
  const lookY = h + LOOK_ABOVE_BAR_TOP;
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
// One clean sans family across every surface — title cards, nameplates,
// value text. INTER is the family name resolved by Remotion's google-fonts
// loader; fallbacks cover the rare frame painted before the font fully
// decodes (delayRender keeps that window short).
const FONT_SANS = `"${INTER}", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
// Alias kept so the existing references in this file don't have to change.
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

// Value text. The number is the protagonist (rendered large + bold);
// `unit` is rendered smaller on a second line below — keeps long unit
// labels like "human deaths per year" from forcing the headline number to
// shrink to nothing on a single-line layout.
function makeValueTex(value: string, unit: string): THREE.CanvasTexture {
  const W = 1024;
  const H = 384;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  ctx.shadowColor = "rgba(14, 20, 48, 0.18)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = VALUE_COLOR;

  if (!unit) {
    // No unit label — single line, big number.
    let size = Math.round(H * 0.74);
    ctx.font = `800 ${size}px ${FONT_SERIF}`;
    while (
      ctx.measureText(value).width > W * 0.92 &&
      size > Math.round(H * 0.3)
    ) {
      size -= 6;
      ctx.font = `800 ${size}px ${FONT_SERIF}`;
    }
    ctx.fillText(value, W / 2, H / 2 + size * 0.36);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 16;
    return tex;
  }

  // Two-line layout. Clean display:caption hierarchy:
  //   number  → ~52% canvas height, the hero
  //   unit    → 40% of the number, clear secondary caption
  //   gap     → ~30% of the number, generous breathing room
  // Auto-shrink falls back gracefully for very long values or units.
  const MAX_W = W * 0.92;
  let valueSize = Math.round(H * 0.52);
  ctx.font = `800 ${valueSize}px ${FONT_SERIF}`;
  while (ctx.measureText(value).width > MAX_W && valueSize > Math.round(H * 0.3)) {
    valueSize -= 6;
    ctx.font = `800 ${valueSize}px ${FONT_SERIF}`;
  }

  let unitSize = Math.round(valueSize * 0.4);
  ctx.font = `500 ${unitSize}px ${FONT_SANS}`;
  while (ctx.measureText(unit).width > MAX_W && unitSize > Math.round(H * 0.1)) {
    unitSize -= 3;
    ctx.font = `500 ${unitSize}px ${FONT_SANS}`;
  }

  const gap = Math.round(valueSize * 0.3);
  const blockH = valueSize + gap + unitSize;
  const topY = (H - blockH) / 2;

  ctx.font = `800 ${valueSize}px ${FONT_SERIF}`;
  ctx.fillText(value, W / 2, topY + valueSize);

  // Unit gets no shadow — the small text reads cleaner without it.
  ctx.shadowColor = "rgba(0,0,0,0)";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = VALUE_COLOR;
  ctx.font = `500 ${unitSize}px ${FONT_SANS}`;
  ctx.fillText(unit, W / 2, topY + valueSize + gap + unitSize);

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

// ───── Components ─────
// Full-frame static photo as the scene background, same pattern as the
// flow template. <primitive attach="background" object={tex}> binds the
// texture to scene.background, which Three.js renders as a fullscreen
// quad — the image stays fixed regardless of camera position, so it
// reads as a wallpaper, not a parallaxed plane. Texture loaded via
// plain TextureLoader (non-suspending) so it never blocks the Scene
// suspense while bg-2.jpg decodes.
function Backdrop() {
  const tex = useMemo(() => {
    const loader = new THREE.TextureLoader();
    const t = loader.load(
      staticFile("bg-2.jpg"),
      undefined,
      undefined,
      () => {
        // swallow load errors — AbsoluteFill bg shows through
      },
    );
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);
  return <primitive attach="background" object={tex} />;
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
  coverTex,
  flagTex,
  frame,
}: {
  index: number;
  N: number;
  item: SortedItem;
  episode: Episode;
  coverTex: THREE.Texture;
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
      makeValueTex(
        formatValueFull(item.value, episode.valueFormat ?? "compact"),
        episode.unitLabel ?? "",
      ),
    [item.value, episode.valueFormat, episode.unitLabel],
  );

  // Front face is at z = +BAR_D/2 ; mount nameplate/value slightly in front.
  const FRONT_Z = BAR_D / 2 + 0.015;

  const nameplateY = h - NAMEPLATE_FROM_TOP;
  const valueY = nameplateY - NAMEPLATE_H / 2 - VALUE_FROM_NAMEPLATE - VALUE_PLANE_H / 2 + 0.4;

  // Card aspect tracks the cover's native dimensions — landscape covers
  // render landscape, portrait portrait, no letterboxing.
  const img = (coverTex.image ?? null) as { width?: number; height?: number } | null;
  const card = fitCardDims(img?.width ?? 0, img?.height ?? 0);
  // Card sits on top of the pillar; CARD_OVERLAP lets its bottom edge dip
  // slightly into the bar top so the card reads as mounted to it.
  const cardY = h + card.h / 2 - CARD_OVERLAP;

  return (
    <group position={[x, 0, 0]}>
      {/* Pillar block — pivot at base so we can scale Y from the floor up.
          Per-face material array gives left + right faces a darker tone so
          the pillar reads as a 3D solid even under flat lighting. Order
          follows BoxGeometry's material indices: 0=+X, 1=-X, 2=+Y, 3=-Y,
          4=+Z (front), 5=-Z (back). */}
      <mesh position={[0, h / 2, 0]}>
        <boxGeometry args={[BAR_W, h, BAR_D]} />
        <meshStandardMaterial
          attach="material-0"
          color={BAR_SIDE_COLOR}
          roughness={0.9}
          metalness={0.02}
        />
        <meshStandardMaterial
          attach="material-1"
          color={BAR_SIDE_COLOR}
          roughness={0.9}
          metalness={0.02}
        />
        <meshStandardMaterial
          attach="material-2"
          color={BAR_COLOR_DARK}
          roughness={0.95}
          metalness={0.02}
        />
        <meshStandardMaterial
          attach="material-3"
          color={BAR_COLOR}
          roughness={0.95}
          metalness={0.02}
        />
        <meshStandardMaterial
          attach="material-4"
          color={BAR_COLOR}
          roughness={0.9}
          metalness={0.02}
        />
        <meshStandardMaterial
          attach="material-5"
          color={BAR_COLOR}
          roughness={0.9}
          metalness={0.02}
        />
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

      {/* Cover card — flat plane that displays the cover image AS-IS at its
          native aspect ratio. No clipping, no halo, no white padding. */}
      <mesh position={[0, cardY, 0.4]}>
        <planeGeometry args={[card.w, card.h]} />
        <meshBasicMaterial map={coverTex} toneMapped={false} />
      </mesh>

      {/* Flag — pole + flag plane only render when the item carries a
          country code. Episodes without country data (e.g. animals) get a
          clean pillar with no orphaned flagpole sticking out the top. */}
      {item.country ? (
        <Flag
          flagTex={flagTex}
          baseX={BAR_W / 2 - 0.4}
          baseY={h}
          z={BAR_D / 2 - 0.4}
          frame={frame}
          index={index}
        />
      ) : null}
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
    runtime.items[0]._barH + LOOK_ABOVE_BAR_TOP + TITLE_OFFSET_FROM_LOOK;
  const outroBoardY =
    runtime.items[runtime.N - 1]._barH + LOOK_ABOVE_BAR_TOP + TITLE_OFFSET_FROM_LOOK;
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
  // Standard color/anisotropy treatment so the cover renders crisp at any
  // camera distance.
  for (const t of covers) {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 16;
  }

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
          coverTex={covers[i]}
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
      <Backdrop />

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
