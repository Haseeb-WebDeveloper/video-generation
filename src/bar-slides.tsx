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

// Hero-flag mode (episode.flagHero === true). Used for flag-themed
// episodes (e.g. "countries by X") where the flag IS the visual — no
// cover card. With showPole=false the pole is invisible, so HERO_POLE_H
// becomes the Y-offset of the flag's pivot above the bar top. Lower
// values sit the flag closer to the pillar; the chosen value puts the
// flag center near the camera's lookAt (LOOK_ABOVE_BAR_TOP + a bit), so
// the flag reads as a billboard hovering just above its pillar rather
// than floating high overhead.
const HERO_POLE_H = 6;
const HERO_FLAG_W = 7.0;
const HERO_FLAG_H = 4.67; // 3:2 aspect (matches normalized flag covers)
const HERO_POLE_R = 0.08; // unused while showPole=false, kept for future toggle

// Camera framing. The pan is one continuous sweep from the first bar to outroX.
// Camera Y tracks the CURRENT bar top so the card + nameplate stay in frame
// even as bars get taller.
//
// LOOK_ABOVE_BAR_TOP: how far ABOVE the bar's top face the camera aims.
// Negative values aim BELOW the bar top — used here to drop the camera a
// touch so the nameplate + value text land in the upper-middle of the
// frame rather than at the bottom. The YouTube player's seekbar/controls
// cover the bottom ~12% of the player when visible; this offset keeps
// the readable text comfortably above that zone.
// CAM_Y_LIFT is how much higher than lookAt the camera sits (gives a slight
// downward gaze, like a person walking past a row of pedestals).
const FOV = 34;
const CAM_DIST = 30;
const LOOK_ABOVE_BAR_TOP = 0.0;
const CAM_Y_LIFT = 1.8;

// Outro board sits beyond the last bar in X. The camera covers this gap in
// its own dedicated EXIT phase at much higher than per-bar speed, so the
// generous spacing reads as "breathing room" rather than "long boring travel."
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
const TITLE_TEXT = "#ffffff"; // primary title color (line 1)
const TITLE_TEXT_SOFT = "rgba(255, 255, 255, 0.9)"; // subtitle / line 2 — same hue at 86% opacity

// Bar X helper — index 0 sits leftmost; sorted so the smallest pillar is first
// and the tallest is last (ascending reveal).
export const barX = (i: number, n: number) =>
  i * SPACING_X - ((n - 1) * SPACING_X) / 2;

export { SPACING_X, BAR_W, MIN_BAR_H, MAX_BAR_H };

// Format the bare numeric value (no unit and no currency prefix). The unit
// label is rendered as a separate line by makeValueTex — if a currency is
// part of the unit (e.g. "USD per gallon"), put it there. Hardcoding "$"
// here was a leftover from when this template was money-focused, and broke
// non-currency rankings like solar masses or population counts.
function formatValueFull(
  m: number,
  format: "compact" | "raw" = "compact",
): string {
  if (format === "raw") return m.toLocaleString("en-US");
  if (m >= 1000) return `${(m / 1000).toFixed(1)} B`;
  return `${m.toFixed(0)} M`;
}

type Vec3 = [number, number, number];
type FocusPose = { camPos: Vec3; lookAt: Vec3 };

// ───── Pacing (60fps) ─────
// Four phases: cinematic intro → constant-velocity bar pan → fast exit →
// outro hold.
//
// The bar pan stays at a CONSTANT velocity (V_BAR = SPACING_X/PER_ITEM_FRAMES)
// so every bar gets identical on-screen time — each one reads cleanly. INTRO
// and EXIT are Hermite curves: INTRO accelerates from rest into V_BAR exactly
// as the camera arrives at the first bar; EXIT mirrors it after the last
// bar. Peak velocity inside each curve is several × V_BAR — the visible
// "cinematic dive in/out." The math links the seams so there are no
// velocity jolts.
// Frame counts at 30 fps — halve/double in lockstep if the root fps
// changes (see Root.tsx). Seconds in the comments are authoritative.
const INTRO_FRAMES = 75; // ~2.5s cinematic dive into the first bar
const PER_ITEM_FRAMES = 100; // ~3.3s per bar at constant velocity
const EXIT_FRAMES = 90; // ~3.0s — dive away from last bar
const HOLD_OUTRO = 45; // ~1.5s static outro hold

// Where the camera starts at frame 0 relative to the first bar.
//   -X = to the LEFT of bar 0 (camera will slide right into it)
//   +Z = farther BACK than the normal pan distance (camera will dolly in)
//   +Y = a touch HIGHER than the normal eye-line (camera settles down as it arrives)
// These three offsets ease independently to zero by the end of the intro,
// so the bar grows in size, drops into the eye-line, and slides toward
// center all at once — a single fluid cinematic move.
const INTRO_X_OFFSET = -22;
const INTRO_Z_OFFSET = 16;
const INTRO_Y_OFFSET = 5;

export function totalFrames(items: EpisodeItem[]): number {
  // (N - 1) bar-to-bar transitions at PER_ITEM_FRAMES each, framed by the
  // intro dive and the exit phase + outro hold.
  const barPanFrames = Math.max(0, items.length - 1) * PER_ITEM_FRAMES;
  return INTRO_FRAMES + barPanFrames + EXIT_FRAMES + HOLD_OUTRO;
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
// Used by the INTRO phase: camera starts still left of the first bar and
// matches the constant bar-pan velocity exactly when it arrives, with peak
// velocity in the middle of the curve being many × V_BAR — the visible
// "cinematic dive in."
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

export function buildRuntime(episode: Episode): EpisodeRuntime {
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
  const outroX = barX(N - 1, N) + OUTRO_DROP_X;

  return {
    items,
    N,
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

// How far above the camera's lookAt the outro board center sits. Tuned so
// the board reads in the upper-middle of the frame, the same position a
// bar's nameplate would occupy.
const TITLE_OFFSET_FROM_LOOK = 1.5;

// Camera dolly applied during the outro hold so it doesn't feel static.
// Small magnitude because the hold is only ~1.5s — the bulk of the visual
// motion comes from the EXIT phase that precedes the outro hold.
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

  const { N, outroX } = runtime;
  const x0 = barX(0, N);
  const xN = barX(N - 1, N);
  const barPanFrames = Math.max(0, N - 1) * PER_ITEM_FRAMES;
  const exitD = outroX - xN; // > 0

  // Phase boundary frames.
  const fBarPan = INTRO_FRAMES;
  const fExit = fBarPan + barPanFrames;
  const fOutroHold = fExit + EXIT_FRAMES;

  let x: number;
  let introZ = 0;
  let introY = 0;
  let dollyZ = 0;
  let dollyY = 0;
  let lookAtFirstBar = false;
  if (frame < fBarPan) {
    // Phase 0: cinematic intro. X eases from (x0 + INTRO_X_OFFSET) to x0
    // via a Hermite curve whose end-velocity is exactly V_BAR, so the
    // transition into the bar pan is seamless. Z/Y dolly in from their
    // start offsets to 0 with a plain smoothstep — slower at the start,
    // faster in the middle, settling cleanly at the seam.
    const u = frame / INTRO_FRAMES;
    x = x0 + INTRO_X_OFFSET + hermiteAccelerate(u, -INTRO_X_OFFSET, INTRO_FRAMES);
    const e = smoothstep(u);
    introZ = (1 - e) * INTRO_Z_OFFSET;
    introY = (1 - e) * INTRO_Y_OFFSET;
    // Keep the first bar as the focal point throughout the intro — the
    // bar slides into screen center as the camera arrives, instead of
    // appearing in the corner of the frame.
    lookAtFirstBar = true;
  } else if (frame < fExit) {
    // Phase 1: constant V_BAR pan through the bar row. Each bar gets the
    // same on-screen time.
    x = x0 + V_BAR * (frame - fBarPan);
  } else if (frame < fOutroHold) {
    // Phase 2: fast exit. Starts at V_BAR, decelerates to rest exactly at
    // the outro position.
    const u = (frame - fExit) / EXIT_FRAMES;
    x = xN + hermiteDecelerate(u, exitD, EXIT_FRAMES);
  } else {
    // Phase 3: outro hold. Subtle pull-back dolly (base → back+up).
    x = outroX;
    const t = smoothstep((frame - fOutroHold) / HOLD_OUTRO);
    dollyZ = t * HOLD_DOLLY_Z;
    dollyY = t * HOLD_DOLLY_Y;
  }

  const pose = camPoseAt(x, runtime);
  let pos: Vec3 = [
    pose.camPos[0],
    pose.camPos[1] + dollyY + introY,
    pose.camPos[2] + dollyZ + introZ,
  ];
  const look = lookAtFirstBar ? camPoseAt(x0, runtime).lookAt : pose.lookAt;

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
  //   unit    → 60% of the number, readable secondary caption (bumped from
  //             40% — at the original size the label was hard to read
  //             at typical pan distance)
  //   gap     → ~22% of the number, tight enough to read as one block
  // Auto-shrink falls back gracefully for very long values or units.
  const MAX_W = W * 0.92;
  let valueSize = Math.round(H * 0.52);
  ctx.font = `800 ${valueSize}px ${FONT_SERIF}`;
  while (ctx.measureText(value).width > MAX_W && valueSize > Math.round(H * 0.3)) {
    valueSize -= 6;
    ctx.font = `800 ${valueSize}px ${FONT_SERIF}`;
  }

  let unitSize = Math.round(valueSize * 0.6);
  ctx.font = `600 ${unitSize}px ${FONT_SANS}`;
  while (ctx.measureText(unit).width > MAX_W && unitSize > Math.round(H * 0.12)) {
    unitSize -= 3;
    ctx.font = `600 ${unitSize}px ${FONT_SANS}`;
  }

  const gap = Math.round(valueSize * 0.22);
  const blockH = valueSize + gap + unitSize;
  const topY = (H - blockH) / 2;

  ctx.font = `800 ${valueSize}px ${FONT_SERIF}`;
  ctx.fillText(value, W / 2, topY + valueSize);

  // Unit gets no shadow — the small text reads cleaner without it.
  ctx.shadowColor = "rgba(0,0,0,0)";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = VALUE_COLOR;
  ctx.font = `600 ${unitSize}px ${FONT_SANS}`;
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
// 3D scene backdrop — sky gradient + low-poly city silhouette + ground +
// atmospheric fog. Built entirely from geometry/materials so there's no
// async texture loading: every frame (video or still) gets the same
// backdrop without a chance of the bg "popping in" or a still being
// captured before the image decodes.
//
// Why not just bg-0.jpeg? Two reasons:
//   1. A static image is camera-locked — as the bar pan slides past the
//      pillars, the sky doesn't parallax. Real-feeling depth requires the
//      backdrop to live in world space.
//   2. Stills won't fire the async image-load reliably, so the bg would
//      appear blank in thumbnails. 3D geometry renders synchronously on
//      the first frame.
export function SceneBackdrop() {
  // ───── Stone-tile floor ─────
  // A repeating tile pattern drawn into a CanvasTexture (synchronous, no
  // image-load to wait on), then tiled across a very wide ground plane.
  // The texture itself is tiny (512×512, 8×8 stone squares) but
  // texture.repeat.set(N, N) tiles it dozens of times across the plane,
  // so the pattern stays crisp from close up to the far horizon.
  const floorTex = useMemo(() => {
    const SIZE = 512;
    const TILES = 8;
    const tileW = SIZE / TILES;
    const c = document.createElement("canvas");
    c.width = c.height = SIZE;
    const ctx = c.getContext("2d")!;

    // Grout base — dark mortar showing through the gaps between tiles.
    ctx.fillStyle = "#3a3530";
    ctx.fillRect(0, 0, SIZE, SIZE);

    // Tiles — varied gray-beige with a tiny per-tile brightness shift so
    // the floor doesn't read as one flat color when tiled at distance.
    // Deterministic per-tile via a hash of (x, y) so the pattern is
    // identical across renders.
    const hash = (x: number, y: number) => {
      const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      return h - Math.floor(h);
    };
    for (let x = 0; x < TILES; x++) {
      for (let y = 0; y < TILES; y++) {
        const variation = hash(x, y) * 0.18 - 0.09; // -9% to +9%
        const base = 0.66 + variation;
        const r = Math.floor(base * 184);
        const g = Math.floor(base * 178);
        const b = Math.floor(base * 168);
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        // Inset by 1.5px on each side to leave grout visible
        ctx.fillRect(x * tileW + 1.5, y * tileW + 1.5, tileW - 3, tileW - 3);
      }
    }

    // Subtle per-pixel noise grain so the tiles don't look plastic.
    const img = ctx.getImageData(0, 0, SIZE, SIZE);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 16;
      img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
      img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
      img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n));
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(60, 60); // ~60× tiling across the 3000-unit plane
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 16;
    return tex;
  }, []);

  // ───── Star field ─────
  // A few thousand random points on a half-sphere above the horizon.
  // BufferGeometry with per-vertex positions + colors → drawn as <points>.
  // sizeAttenuation=false keeps each star a fixed pixel size at any
  // distance, mimicking how stars actually look in photographs.
  const starGeo = useMemo(() => {
    const COUNT = 3500;
    const positions = new Float32Array(COUNT * 3);
    const colors = new Float32Array(COUNT * 3);
    let s = 0xa5b6c7d8 >>> 0;
    const rng = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < COUNT; i++) {
      // Sample uniformly on a sphere, then keep only the upper
      // hemisphere (y > -0.1) so stars don't poke through the floor.
      const theta = rng() * Math.PI * 2;
      const u = rng() * 1.1 - 0.1; // bias toward upper sphere
      const phi = Math.acos(u);
      const r = 700 + rng() * 200; // slight depth variation
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);

      // Most stars are pale white; a few percent get a warm or cool tint
      // for a touch of variety (real night-sky stars have visible color).
      const t = rng();
      const brightness = 0.55 + rng() * 0.45;
      let r2 = brightness, g2 = brightness, b2 = brightness;
      if (t < 0.05) {
        // ~5% warm (orange giants)
        r2 *= 1.0;
        g2 *= 0.78;
        b2 *= 0.62;
      } else if (t < 0.10) {
        // ~5% cool (blue-white)
        r2 *= 0.78;
        g2 *= 0.86;
        b2 *= 1.0;
      }
      colors[i * 3] = r2;
      colors[i * 3 + 1] = g2;
      colors[i * 3 + 2] = b2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return g;
  }, []);

  // ───── Nebula glow (the pink cosmic accent in the reference) ─────
  // A radial-gradient sprite drawn into a CanvasTexture and rendered with
  // additive blending against the dark sky. Sits high and to the side so
  // it reads as a distant cosmic feature, not a center of attention.
  //
  // Per-pixel noise is added after the gradient is drawn — soft dark
  // gradients suffer hard color banding in 8-bit output (visible as
  // concentric "rings" stepping out from the bright center). The noise
  // dithers neighboring color values so the human eye averages them into
  // a smooth ramp.
  const nebulaTex = useMemo(() => {
    const S = 512;
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const ctx = c.getContext("2d")!;
    const grd = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, "rgba(255, 130, 160, 0.55)"); // pink core
    grd.addColorStop(0.3, "rgba(190, 90, 150, 0.32)"); // magenta mid
    grd.addColorStop(0.65, "rgba(80, 40, 110, 0.10)"); // dim purple haze
    grd.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, S, S);
    // Dither: add small random noise to each pixel's alpha so the soft
    // ramp doesn't band into visible stripes when additively blended.
    const img = ctx.getImageData(0, 0, S, S);
    for (let i = 0; i < img.data.length; i += 4) {
      const a = img.data[i + 3];
      if (a > 0 && a < 255) {
        const n = (Math.random() - 0.5) * 12;
        img.data[i + 3] = Math.max(0, Math.min(255, a + n));
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  return (
    <>
      {/* Sky fill — flat near-black via scene.background. Stars and
          nebulae sit on top of this. Using <color> primitive is
          synchronous and bulletproof for stills. */}
      <color attach="background" args={["#040611"]} />

      {/* Star field — points geometry, fixed pixel size, vertex colors.
          size=2.8 makes individual stars clearly visible at 1080p+; the
          previous 1.6 disappeared at viewing distance. Brighter stars
          aren't needed — the per-vertex brightness variation reads better
          than a higher overall size. */}
      <points geometry={starGeo}>
        <pointsMaterial
          size={2.8}
          vertexColors
          sizeAttenuation={false}
          transparent
          depthWrite={false}
        />
      </points>

      {/* Nebula glow — distinctive pink-magenta cosmic accent, upper
          left of frame to match the reference image. */}
      <sprite position={[-380, 240, -600]} scale={[260, 260, 1]}>
        <spriteMaterial
          map={nebulaTex}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </sprite>

      {/* Stone-tile floor — large plane at y=0 (where bars stand). The
          CanvasTexture tiles across so the grid stays crisp from
          foreground to horizon. roughness=0.85 picks up cool moonlight
          highlights from the directional lights without going plastic. */}
      <mesh position={[0, -0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[3000, 3000]} />
        <meshStandardMaterial
          map={floorTex}
          roughness={0.85}
          metalness={0.05}
          color="#bdb5a8"
        />
      </mesh>

      {/* Atmospheric fog — blends the far edge of the floor toward the
          sky color so the horizon doesn't cut hard. */}
      <fog attach="fog" args={["#080a14", 350, 900]} />
    </>
  );
}

// Legacy texture-based backdrop, kept exported in case existing code
// imports it. New scenes should use SceneBackdrop instead.
export function Backdrop() {
  return <SceneBackdrop />;
}

function Flag({
  flagTex,
  baseX,
  baseY,
  z,
  frame,
  index,
  poleH = POLE_H,
  poleR = POLE_R,
  flagW = FLAG_W,
  flagH = FLAG_H,
  showPole = true,
}: {
  flagTex: THREE.Texture | null;
  baseX: number;
  baseY: number;
  z: number;
  frame: number;
  index: number;
  poleH?: number;
  poleR?: number;
  flagW?: number;
  flagH?: number;
  showPole?: boolean;
}) {

  // Flags are STILL — no wave, no tilt, no bob. Earlier iterations had
  // multi-frequency cloth motion but it read as wobbly/cheap rather than
  // organic, so we just freeze the flag facing the camera. Static reads
  // as a deliberate billboard, which is what we want for a ranking video.
  // `frame` and `index` are kept in the signature so callers don't change.
  void frame;
  void index;
  const sway = 0;
  const tilt = 0;
  const bobY = 0;
  const bobZ = 0;

  return (
    <group position={[baseX, baseY, z]}>
      {showPole && (
        <>
          {/* Pole */}
          <mesh position={[0, poleH / 2, 0]}>
            <cylinderGeometry args={[poleR, poleR, poleH, 12]} />
            <meshStandardMaterial color="#c9b274" metalness={0.6} roughness={0.4} />
          </mesh>
          {/* Pole cap */}
          <mesh position={[0, poleH + 0.08, 0]}>
            <sphereGeometry args={[poleR * 1.8, 12, 12]} />
            <meshStandardMaterial color="#e6cf86" metalness={0.7} roughness={0.3} />
          </mesh>
        </>
      )}
      {/* Flag — pivot at left edge so rotation looks like wind catching
          the free side. With showPole=false, bobY + bobZ make the flag
          read as floating in air rather than pinned to an invisible point. */}
      {flagTex && (
        <group
          position={[0, poleH - flagH * 0.6 + bobY, bobZ]}
          rotation={[0, sway, tilt]}
        >
          <mesh position={[flagW / 2, 0, 0]}>
            <planeGeometry args={[flagW, flagH, 16, 6]} />
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

export function Pillar({
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

      {episode.flagHero ? (
        /* Hero-flag mode: a single large 3:2 flag on a tall pole, centered
           on the bar. No cover card, no small corner flag. Uses the cover
           texture (which the build pipeline normalized to a uniform 3:2
           crop) so the big flag is high-resolution and uniformly framed
           across all bars. */
        <Flag
          flagTex={coverTex}
          baseX={-HERO_FLAG_W / 2}
          baseY={h}
          z={BAR_D / 2 - 0.4}
          frame={frame}
          index={index}
          poleH={HERO_POLE_H}
          poleR={HERO_POLE_R}
          flagW={HERO_FLAG_W}
          flagH={HERO_FLAG_H}
          showPole={false}
        />
      ) : (
        <>
          {/* Cover card — flat plane that displays the cover image AS-IS at
              its native aspect ratio. No clipping, no halo, no white padding. */}
          <mesh position={[0, cardY, 0.4]}>
            <planeGeometry args={[card.w, card.h]} />
            <meshBasicMaterial map={coverTex} toneMapped={false} />
          </mesh>

          {/* Standard flagpole — small flag at the bar's top-front-right
              corner. Only renders when the item carries a country code. */}
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
        </>
      )}
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

// Outro board is kept OUTSIDE the cover-loading Suspense so it renders even
// if some cover textures are still decoding.
function OutroBoard({
  episode,
  runtime,
}: {
  episode: Episode;
  runtime: EpisodeRuntime;
}) {
  const outroTex = useMemo(
    () => makeTitleTex(episode.outro[0], episode.outro[1]),
    [episode.outro],
  );
  // Board sits at the camera's natural framing for the last bar — same Y a
  // bar's nameplate would occupy from this distance — so the cut from pan
  // into outro hold involves no Y change.
  const outroBoardY =
    runtime.items[runtime.N - 1]._barH + LOOK_ABOVE_BAR_TOP + TITLE_OFFSET_FROM_LOOK;
  return (
    <TextBoard
      position={[runtime.outroX, outroBoardY, 0]}
      texture={outroTex}
    />
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
      <SceneBackdrop />

      {/* Ambient is dim + cool so the night sky reads as night; the
          directional lights below do most of the work lighting the cream
          pillars so they pop against the dark backdrop. */}
      <ambientLight intensity={0.55} color="#9ab0d8" />
      {/* Cool moonlight key from upper-left. Stronger than before because
          the starfield sky absorbs more contrast than the old gradient
          backdrop did, so the cream pillars need extra lift to read
          clearly without changing the sky brightness. */}
      <directionalLight
        position={[-30, 50, 25]}
        intensity={1.4}
        color="#dfe6ff"
      />
      {/* Warm rim from front-right — adds a hint of gold to the edges
          of each pillar so they don't go completely cool/dead. */}
      <directionalLight
        position={[25, 12, 18]}
        intensity={0.55}
        color="#f4b06a"
      />

      <OutroBoard episode={episode} runtime={runtime} />
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
        // `loop` so a short music bed repeats across long compositions.
        // No-op when the clip is already at least the composition length.
        <Audio src={staticFile(episode.audioPath)} volume={fadeVolume} loop />
      )}
    </AbsoluteFill>
  );
};
