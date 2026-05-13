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
import { Episode, EpisodeIntroCard, EpisodeItem } from "./episode";

// ───── Geometry ─────
// Cover sizing — covers fit inside a max bounding box; landscape/portrait
// images shrink to fit without cropping.
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

function formatValue(m: number, format: "compact" | "raw" = "compact"): string {
  if (format === "raw") return m.toLocaleString("en-US");
  if (m >= 1000) return `${(m / 1000).toFixed(1)}B`;
  return `${m}M`;
}

type Vec3 = [number, number, number];

// ADJUST: camera framing — sets how close cards read on screen. The continuous pan flows the row past the camera; with
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
const PHASE_INTRO = 70; // ~1s swoop-in for episodes WITHOUT intro cards
const PER_ITEM_FRAMES = 300; // ~5s per card-spacing of camera travel
const TAIL_PADDING = 120; // ~2s outro hold

// ───── Cinematic intro (only when episode.intro is set) ─────
// A long, deliberate camera approach into the first intro card, paired with
// a Z dolly so the card grows from a wide establishing shot into the
// foreground. This is meaningfully different from the regular card-to-card
// pan so the audience feels "ok, the show hasn't started yet — this is
// context" rather than perceiving the first card as item #20.
const CINEMATIC_INTRO_FRAMES = 240; // ~4s slow approach instead of ~1s swoop
// Extra X distance the camera travels during the cinematic swoop. Bigger
// than the no-intro SWOOP_OFFSET so the camera covers visible ground at a
// slower per-frame speed.
const CINEMATIC_SWOOP_OFFSET_X = 26;
const SWOOP_OFFSET_X = 14;
// Z pullback added at frame 0 of the cinematic intro. The camera starts
// this far back from CAM_DIST and eases forward to CAM_DIST by the end of
// the swoop, creating a subtle zoom-in. 0 = no dolly.
const CINEMATIC_Z_PULLBACK = 22;
// Easing for the cinematic approach. Smoother than the regular swoop's
// bezier(0.45, 0, 0.2, 1) — gentler in/out so the slow approach reads as
// deliberate rather than mechanical.
const easeCinematic = Easing.bezier(0.35, 0, 0.25, 1);

export function totalFrames(episode: {
  items: EpisodeItem[];
  intro?: EpisodeIntroCard[];
  showTitleBoard?: boolean;
}): number {
  const introCount = episode.intro?.length ?? 0;
  if (introCount === 0) {
    // Backward-compatible path for episodes without intro — preserves the
    // exact frame count of pre-intro renders so older episodes stay
    // bit-for-bit equivalent.
    return (
      PHASE_INTRO + episode.items.length * PER_ITEM_FRAMES + TAIL_PADDING
    );
  }
  // With intro: each card (intro, [title], ranked, outro) is an explicit
  // waypoint that gets PER_ITEM_FRAMES of camera transit. Waypoint count
  // depends on whether the title board is visible.
  const showsTitle = episode.showTitleBoard !== false;
  const panSegments =
    introCount + episode.items.length + (showsTitle ? 1 : 0);
  return CINEMATIC_INTRO_FRAMES + panSegments * PER_ITEM_FRAMES + TAIL_PADDING;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function clamp01(t: number) {
  return Math.max(0, Math.min(1, t));
}

const easeInOut = Easing.bezier(0.45, 0, 0.2, 1);

// Gap from the last intro card center to the title board. Bigger than
// CARD_GAP so the title reads as a clear section break between the "context"
// primers and the ranking countdown.
const INTRO_TITLE_GAP = 16;

// ───── Layout ─────
// Computed from actual cover dimensions (widths come from loaded textures).
// `centers[i]` is the X position of card i's center; the camera path
// derives titleX/outroX/startCamX from those endpoints.
//
// When `intro` cards are present, they sit to the LEFT of the title board
// (the title still anchors the ranking row's starting edge). Camera order
// becomes: startCamX → intro cards → title → ranking cards → outroX, with
// each waypoint getting PER_ITEM_FRAMES of explicit camera transit (the
// `waypoints` array). This replaces the original single linear lerp so that
// intro cards can never be visually rushed relative to ranked items.
type Layout = {
  centers: number[];
  introCenters: number[];
  titleX: number;
  outroX: number;
  startCamX: number;
  // Original (no-intro) behaviour uses a single titleX→outroX lerp over
  // travelFrames. Kept for the backward-compat path.
  travelFrames: number;
  // New (with-intro) behaviour walks the camera through these waypoints in
  // order, spending PER_ITEM_FRAMES on each segment. Includes startCamX as
  // the first entry so the swoop segment shares the same machinery.
  waypoints: number[];
};

function buildLayout(
  coverWidths: number[],
  introWidths: number[],
  showTitle: boolean,
): Layout {
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

  // Place intro cards working LEFTWARD from their anchor.
  //   With title:    rightmost intro sits INTRO_TITLE_GAP left of titleX
  //                  (extra gap to set the title board apart visually).
  //   Without title: rightmost intro sits CARD_GAP left of the first
  //                  ranked card, so intro→ranked transitions move at the
  //                  same per-frame speed as ranked→ranked.
  const Ni = introWidths.length;
  const introCenters: number[] = new Array(Ni);
  const anchorX = showTitle ? titleX : first;
  const anchorGap = showTitle ? INTRO_TITLE_GAP : CARD_GAP;
  const anchorHalfWidth = showTitle ? 0 : (coverWidths[0] ?? 0) / 2;
  let introCursor = anchorX - anchorGap - anchorHalfWidth;
  for (let i = Ni - 1; i >= 0; i--) {
    introCursor -= introWidths[i] / 2;
    introCenters[i] = introCursor;
    introCursor -= introWidths[i] / 2 + CARD_GAP;
  }

  const leftmostX = Ni > 0 ? introCenters[0] : titleX;
  const startCamX =
    leftmostX - (Ni > 0 ? CINEMATIC_SWOOP_OFFSET_X : SWOOP_OFFSET_X);

  // Chronological camera waypoints. Segment 0 (swoop) consumes PHASE_INTRO
  // or CINEMATIC_INTRO_FRAMES; every subsequent segment consumes
  // PER_ITEM_FRAMES. titleX is included only when showTitle, so its 5-second
  // dwell is removed entirely from the camera path when the board is hidden.
  const waypoints = [
    startCamX,
    ...introCenters,
    ...(showTitle ? [titleX] : []),
    ...centers,
    outroX,
  ];

  return {
    centers,
    introCenters,
    titleX,
    outroX,
    startCamX,
    travelFrames: (Ni + N) * PER_ITEM_FRAMES,
    waypoints,
  };
}

function cameraXAt(frame: number, layout: Layout): number {
  // No intro → original behaviour preserved bit-for-bit. The pan is a single
  // lerp from titleX to outroX over N×PER_ITEM_FRAMES, so the title and
  // outro share the same continuous motion as the ranking cards.
  if (layout.introCenters.length === 0) {
    if (frame < PHASE_INTRO) {
      const t = easeInOut(clamp01(frame / PHASE_INTRO));
      return lerp(layout.startCamX, layout.titleX, t);
    }
    const N = layout.centers.length;
    const travelFrames = N * PER_ITEM_FRAMES;
    const travelEnd = PHASE_INTRO + travelFrames;
    if (frame < travelEnd) {
      const t = clamp01((frame - PHASE_INTRO) / travelFrames);
      return lerp(layout.titleX, layout.outroX, t);
    }
    return layout.outroX;
  }

  // Intro present → cinematic swoop into intro 1, then segmented waypoint
  // pan. The swoop is ~4× longer than the no-intro swoop, uses a softer
  // easing, and pairs with a Z dolly (in CameraRig) so the first intro
  // card grows into the foreground rather than slamming into position.
  // After the swoop, each card (intro, title, ranked, outro) gets exactly
  // PER_ITEM_FRAMES of camera transit — pacing immune to width/gap variation.
  const w = layout.waypoints;
  if (frame < CINEMATIC_INTRO_FRAMES) {
    const t = easeCinematic(clamp01(frame / CINEMATIC_INTRO_FRAMES));
    return lerp(w[0], w[1], t);
  }
  const panFrame = frame - CINEMATIC_INTRO_FRAMES;
  // Segment 0 was the swoop. Pan segments start at index 1.
  const segIdx = 1 + Math.floor(panFrame / PER_ITEM_FRAMES);
  if (segIdx >= w.length - 1) return w[w.length - 1];
  const segFrame = panFrame % PER_ITEM_FRAMES;
  const t = clamp01(segFrame / PER_ITEM_FRAMES);
  return lerp(w[segIdx], w[segIdx + 1], t);
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

  // Cinematic Z dolly during the intro swoop: camera starts CINEMATIC_Z_PULLBACK
  // units further from the scene and eases forward to CAM_DIST by the time
  // the swoop ends. After the swoop, Z is locked to CAM_DIST. No-intro
  // episodes skip this entirely so their look is unchanged.
  const hasIntro = layout.introCenters.length > 0;
  let dollyZ = 0;
  if (hasIntro) {
    const introT = clamp01(frame / CINEMATIC_INTRO_FRAMES);
    dollyZ = (1 - easeCinematic(introT)) * CINEMATIC_Z_PULLBACK;
  }

  const time = frame / 60;
  const px = x + CAM_X_OFFSET + Math.sin(time * 0.7) * 0.04;
  const py = TITLE_Y + CAM_Y_OFFSET + Math.cos(time * 0.55) * 0.03;
  const pz = CAM_DIST + dollyZ + Math.sin(time * 0.45) * 0.03;

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
  valueFormat: "compact" | "raw" = "compact",
): number {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  const FONT =
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  const maxW = LABEL_W * 0.94;

  ctx.font = `600 ${LABEL_FONT_BASE}px ${FONT}`;
  let widestValue = 0;
  for (const it of items) {
    const text = `${formatValue(it.value, valueFormat)} ${unitLabel}`;
    const w = ctx.measureText(text).width;
    if (w > widestValue) widestValue = w;
  }
  let candidate =
    widestValue <= maxW
      ? LABEL_FONT_BASE
      : Math.floor(LABEL_FONT_BASE * (maxW / widestValue));

  // If any title needs to wrap to 2 lines at the candidate, the canvas must
  // also fit 2 title lines + value gap + value line + descender. Solving
  // (topY=0.08H, lineH=1.08F, valueGap=0.05H, descender≈0.25F):
  //   0.13H + 3.16F + 0.25F ≤ H  →  F ≤ 0.255H
  ctx.font = `700 ${candidate}px ${FONT}`;
  const anyWraps = items.some(
    (it) => ctx.measureText(it.title).width > maxW,
  );
  if (anyWraps) {
    candidate = Math.min(candidate, Math.floor(LABEL_H * 0.25));
  }

  return Math.max(LABEL_FONT_MIN, candidate);
}

function makeLabel(
  item: EpisodeItem,
  unitLabel: string,
  fontSize: number,
  valueFormat: "compact" | "raw" = "compact",
): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = LABEL_W;
  c.height = LABEL_H;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, LABEL_W, LABEL_H);

  const FONT =
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  const valueText = `${formatValue(item.value, valueFormat)} ${unitLabel}`;
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

// ───── Intro card label ─────
// Same label canvas dims as the ranking labels so cards look identical in
// shape, but the content is { label, caption } instead of { title, value }.
// Caption uses the accent orange to mirror the value-line treatment on the
// ranking cards — viewers' eyes track to the same place on every card.
//
// When `caption` is empty/undefined, the label renders as a single block
// vertically centered in the canvas — used for one-liners like
// "OUR SUN = 1 SOLAR MASS" where the data is baked into the label itself.
function makeIntroLabel(
  label: string,
  caption: string | undefined,
  fontSize: number,
): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = LABEL_W;
  c.height = LABEL_H;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, LABEL_W, LABEL_H);

  const FONT =
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  const maxW = LABEL_W * 0.94;
  const captionGap = LABEL_H * 0.05;

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  const hasCaption = !!caption && caption.trim().length > 0;

  // For one-liners (no caption), shrink the font until the label fits on a
  // single line. The chosen `fontSize` is the episode-wide size derived from
  // the longest ranked-card value string; a label like "OUR SUN = 1 SOLAR
  // MASS" can be wider than that, so we shrink instead of wrapping — a
  // wrap on intro one-liners reads as "this card's label is bad" rather
  // than as intentional design.
  let renderSize = fontSize;
  let labelLines: string[];

  if (!hasCaption) {
    ctx.font = `700 ${renderSize}px ${FONT}`;
    while (
      ctx.measureText(label).width > maxW &&
      renderSize > LABEL_FONT_MIN
    ) {
      renderSize -= 4;
      ctx.font = `700 ${renderSize}px ${FONT}`;
    }
    labelLines = [label];
  } else {
    // With caption: keep the episode-wide size and wrap to 2 lines if the
    // label overflows (mirrors makeLabel behavior).
    ctx.font = `700 ${renderSize}px ${FONT}`;
    if (ctx.measureText(label).width <= maxW) {
      labelLines = [label];
    } else {
      const words = label.split(" ");
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
      labelLines = wrapped ?? [label];
    }
  }

  const lineH = renderSize * 1.08;

  if (hasCaption) {
    // Two-line layout: label(s) on top in white, caption below in accent.
    const topY = LABEL_H * 0.08;

    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${renderSize}px ${FONT}`;
    for (let i = 0; i < labelLines.length; i++) {
      const y = topY + renderSize + i * lineH;
      ctx.fillText(labelLines[i], LABEL_W / 2, y);
    }

    ctx.fillStyle = ACCENT_ORANGE;
    ctx.font = `600 ${renderSize}px ${FONT}`;
    const captionY =
      topY + labelLines.length * lineH + captionGap + renderSize;
    ctx.fillText(caption!, LABEL_W / 2, captionY);
  } else {
    // Caption-less: vertically center the single-line label in the canvas.
    const blockH =
      labelLines.length * renderSize +
      (labelLines.length - 1) * (lineH - renderSize);
    const yStart = (LABEL_H - blockH) / 2 + renderSize;

    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${renderSize}px ${FONT}`;
    for (let i = 0; i < labelLines.length; i++) {
      const y = yStart + i * lineH;
      ctx.fillText(labelLines[i], LABEL_W / 2, y);
    }
  }

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

// ───── Intro cover (no rank badge) ─────
// Identical to FloatingCover but without the rank number plane on top. Used
// for scale-primer cards rendered before the title board; they're not part
// of the countdown so they shouldn't show a rank.
function IntroCover({
  x,
  coverTex,
  labelTex,
  coverW,
  coverH,
}: {
  x: number;
  coverTex: THREE.Texture;
  labelTex: THREE.Texture;
  coverW: number;
  coverH: number;
}) {
  const labelY = -coverH / 2 - LABEL_GAP - LABEL_PLANE_H / 2;
  return (
    <group position={[x, ROW_Y, ROW_Z]}>
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


// ───── Static image backdrop ─────
// Renders public/bg-0.jpeg as the scene background — a flat fullscreen quad
// that always fills the canvas regardless of camera position, so the image
// reads as a fixed wallpaper rather than a parallaxed plane.
function Backdrop() {
  const tex = useTexture(staticFile("bg-0.jpeg"));
  tex.colorSpace = THREE.SRGBColorSpace;
  return <primitive attach="background" object={tex} />;
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
  const introCards = useMemo<EpisodeIntroCard[]>(
    () => episode.intro ?? [],
    [episode.intro],
  );

  const coverPaths = useMemo(
    () => items.map((it) => staticFile(it.imagePath ?? "")),
    [items],
  );
  const covers = useTexture(coverPaths);

  // Intro covers are loaded as a separate batch so empty-intro episodes pay
  // no cost. Each path is staticFile()-resolved; cards without `image` are
  // skipped at the layout level.
  const introCoverPaths = useMemo(
    () => introCards.filter((c) => !!c.image).map((c) => staticFile(c.image!)),
    [introCards],
  );
  const introCovers = useTexture(introCoverPaths);
  const validIntro = useMemo(
    () => introCards.filter((c) => !!c.image),
    [introCards],
  );

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

  const introDims = useMemo(() => {
    return introCovers.map((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 16;
      t.needsUpdate = true;
      const img = t.image as { width?: number; height?: number } | undefined;
      return fitCoverDims(img?.width ?? 0, img?.height ?? 0);
    });
  }, [introCovers]);

  // Whether to render and reserve a pan segment for the title board.
  // Defaults to true; episodes can opt out via `showTitleBoard: false` when
  // their intro cards already serve as the topic introduction.
  const showTitle = episode.showTitleBoard !== false;

  // Layout: card centers spaced by their actual widths plus a fixed gap.
  // Intro card widths feed the same builder so they sit on the same row
  // with consistent spacing. `showTitle` affects intro anchoring AND whether
  // titleX appears as a camera waypoint.
  const layout = useMemo(
    () =>
      buildLayout(
        dims.map((d) => d.w),
        introDims.map((d) => d.w),
        showTitle,
      ),
    [dims, introDims, showTitle],
  );

  const labelFontSize = useMemo(
    () =>
      chooseLabelFontSize(
        items,
        episode.unitLabel,
        episode.valueFormat ?? "compact",
      ),
    [items, episode.unitLabel, episode.valueFormat],
  );
  const labels = useMemo(
    () =>
      items.map((it) =>
        makeLabel(
          it,
          episode.unitLabel,
          labelFontSize,
          episode.valueFormat ?? "compact",
        ),
      ),
    [items, episode.unitLabel, labelFontSize, episode.valueFormat],
  );
  const introLabels = useMemo(
    () =>
      validIntro.map((c) =>
        makeIntroLabel(c.label, c.caption, labelFontSize),
      ),
    [validIntro, labelFontSize],
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

      {validIntro.map((card, i) => (
        <IntroCover
          key={`intro-${i}`}
          x={layout.introCenters[i]}
          coverTex={introCovers[i]}
          labelTex={introLabels[i]}
          coverW={introDims[i].w}
          coverH={introDims[i].h}
        />
      ))}
      {showTitle && (
        <TextBoard position={[layout.titleX, TITLE_Y, 0]} texture={titleTex} />
      )}
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
