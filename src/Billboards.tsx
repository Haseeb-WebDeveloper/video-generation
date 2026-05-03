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
// Pure floating cover images, no billboard frame. Cover is the hero.
// Square covers — image cropped to fit (object-cover behavior).
const COVER_W = 9.5;
const COVER_H = 9.5; // 1:1 square
const COVER_BORDER = 0.07;
const COVER_BORDER_DEPTH = 0.05;

// Label plane aspect MUST match the canvas aspect (2048×560) so text doesn't
// stretch. Plane H computed from W to maintain ratio. Plane is wider so the
// (now larger) text reads bigger in frame.
const LABEL_PLANE_W = 10.0;
const LABEL_PLANE_H = (LABEL_PLANE_W * 560) / 2048; // 2.73
const LABEL_GAP = 0.45;

const SPACING_X = 10.5;
const Z_JIG = 3.6;
const Y_JIG = 0.5;
const TILT_DEG = 18;

const FOV = 30;

// Title and outro waypoint X positions (off the row, at far ends)
const TITLE_DROP_X = -22; // distance to the LEFT of #20 where title sits
const OUTRO_DROP_X = 22;  // distance to the RIGHT of #1 where outro sits

// Title and outro plane sizes — aspect MUST match canvas (2048×1024 = 2:1)
const TITLE_PLANE_W = 13;
const TITLE_PLANE_H = TITLE_PLANE_W / 2; // 6.5 → 2:1 aspect

// ───── Palette ─────
const BG_COLOR = "#040814";
const COVER_TRIM = "#1a1f2a";
const ACCENT_ORANGE = "#f5b35a";

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
const N = ordered.length;
const maxValue = Math.max(...games.map((g) => g.copiesMillions));

const coverX = (i: number) => i * SPACING_X - ((N - 1) * SPACING_X) / 2;
const coverZ = (i: number) => (i % 2 === 0 ? -Z_JIG : Z_JIG);
const coverY = (i: number) => 5 + Math.sin(i * 0.9) * Y_JIG;
const coverRotY = (i: number) => {
  const center = (N - 1) / 2;
  const t = (i - center) / center;
  return -t * (TILT_DEG * Math.PI) / 180;
};

const TITLE_X = coverX(0) + TITLE_DROP_X;
const OUTRO_X = coverX(N - 1) + OUTRO_DROP_X;
// Title/outro face the camera path (same tilt convention as covers)
const TITLE_ROT_Y = ((TILT_DEG + 6) * Math.PI) / 180;
const OUTRO_ROT_Y = -((TILT_DEG + 6) * Math.PI) / 180;
const TITLE_Y = 5;
const OUTRO_Y = 5;

function formatValue(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)}B`;
  return `${m}M`;
}

type Vec3 = [number, number, number];
type FocusPose = { camPos: Vec3; lookAt: Vec3 };

const CAM_DIST = 28;
const CAM_Y_OFFSET = -3.0;
const CAM_X_OFFSET = 1.5;

function coverFocusPose(i: number): FocusPose {
  const x = coverX(i);
  const y = coverY(i);
  const z = coverZ(i);
  // Cover+label visual center sits below cover center because of the label
  // plane below the (now-square) cover. Bias lookAt down to center the pair.
  return {
    camPos: [x + CAM_X_OFFSET, y + CAM_Y_OFFSET, z + CAM_DIST],
    lookAt: [x, y - 0.9, z],
  };
}

const titleFocusPose: FocusPose = {
  camPos: [TITLE_X + CAM_X_OFFSET, TITLE_Y + CAM_Y_OFFSET + 1, CAM_DIST],
  lookAt: [TITLE_X, TITLE_Y - 0.4, 0],
};

const outroFocusPose: FocusPose = {
  camPos: [OUTRO_X + CAM_X_OFFSET, OUTRO_Y + CAM_Y_OFFSET + 1, CAM_DIST],
  lookAt: [OUTRO_X, OUTRO_Y - 0.4, 0],
};

// All waypoints: title → cover[0..N-1] → outro
const waypoints: FocusPose[] = [
  titleFocusPose,
  ...ordered.map((_, i) => coverFocusPose(i)),
  outroFocusPose,
];
const NW = waypoints.length;

// Per-waypoint dwell weights. Title and outro get extra time so the viewer
// can read them; covers get progressive boost for top ranks.
const waypointWeights: number[] = [
  2.6, // title — extra reading time
  ...ordered.map((g) => {
    const t = Math.sqrt(g.copiesMillions / maxValue);
    return 0.85 + 1.0 * t;
  }),
  2.6, // outro — extra reading time
];
const cumWeights = [0];
for (let i = 0; i < waypointWeights.length; i++)
  cumWeights.push(cumWeights[i] + waypointWeights[i]);
const totalWeight = cumWeights[cumWeights.length - 1];

function progressToFloatIdx(p: number): number {
  const target = p * totalWeight;
  for (let i = 0; i < waypointWeights.length; i++) {
    if (cumWeights[i + 1] >= target) {
      const segStart = cumWeights[i];
      const segEnd = cumWeights[i + 1];
      const f = (target - segStart) / (segEnd - segStart);
      return i + f;
    }
  }
  return waypointWeights.length - 1;
}

// ───── Pacing (60fps) ─────
// One continuous shot: opening dolly into the title, then a single weighted
// spline through title → 20 covers → outro. No discrete hold anywhere.
const PHASE_INTRO = 100; // ~1.67s opening dolly to title
const PHASE_TRAVEL = 3700; // ~61.7s through all 22 waypoints
export const TOTAL_FRAMES = PHASE_INTRO + PHASE_TRAVEL + 60;

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

// Float index of the focal waypoint at a given frame
// Returns 0 for title, 1..N for covers (so cover[i] is index i+1), N+1 for outro
function focalIdxAt(frame: number): number {
  if (frame < PHASE_INTRO) return 0;
  if (frame < PHASE_INTRO + PHASE_TRAVEL) {
    const tNorm = (frame - PHASE_INTRO) / PHASE_TRAVEL;
    return progressToFloatIdx(tNorm);
  }
  return NW - 1;
}

function CameraRig({ frame }: { frame: number }) {
  const camera = useThree((s) => s.camera);

  let pos: Vec3;
  let look: Vec3;

  if (frame < PHASE_INTRO) {
    const t = frame / PHASE_INTRO;
    const e = easeInOut(t);
    pos = lerpVec3(startPose.camPos, waypoints[0].camPos, e);
    look = lerpVec3(startPose.lookAt, waypoints[0].lookAt, e);
  } else {
    const tNorm = clamp01(
      (frame - PHASE_INTRO) / PHASE_TRAVEL,
    );
    const floatIdx = progressToFloatIdx(tNorm);
    const a = Math.min(Math.floor(floatIdx), NW - 2);
    const b = a + 1;
    const f = smoothstep(floatIdx - a);
    pos = lerpVec3(waypoints[a].camPos, waypoints[b].camPos, f);
    look = lerpVec3(waypoints[a].lookAt, waypoints[b].lookAt, f);
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
// "03 — Grand Theft Auto V" on top (white), "175M copies sold" below (orange).
// LABEL_H tuned so even 2-line wrapped titles fit with safe padding.
const LABEL_W = 2048;
const LABEL_H = 560;

function makeLabel(game: Game): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = LABEL_W;
  c.height = LABEL_H;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, LABEL_W, LABEL_H);

  const FONT =
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  // Bigger text per request — kept just under prior wrap thresholds so 2-line
  // titles still fit comfortably in the canvas height.
  const titleBaseSize = Math.round(LABEL_H * 0.34);
  const valueSize = Math.round(LABEL_H * 0.27);

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  const rankStr = String(game.rank).padStart(2, "0");
  const titleLine = `${rankStr} — ${game.title}`;

  const lines = wrapText(ctx, titleLine, LABEL_W * 0.94, titleBaseSize, 700);
  const actualTitle = lines[0].size;
  const titleLineH = actualTitle * 1.08;

  const valueGap = LABEL_H * 0.05;
  const blockH = lines.length * titleLineH + valueGap + valueSize;
  // Center vertically with safe padding above/below
  const topY = Math.max(LABEL_H * 0.08, (LABEL_H - blockH) / 2);

  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${actualTitle}px ${FONT}`;
  for (let i = 0; i < lines.length; i++) {
    const y = topY + actualTitle + i * titleLineH;
    ctx.fillText(lines[i].text, LABEL_W / 2, y);
  }

  ctx.fillStyle = ACCENT_ORANGE;
  ctx.font = `600 ${valueSize}px ${FONT}`;
  const valueY = topY + lines.length * titleLineH + valueGap + valueSize;
  ctx.fillText(
    `${formatValue(game.copiesMillions)} copies sold`,
    LABEL_W / 2,
    valueY,
  );

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

// wrapText — tries 1-line at large sizes, falls back to 2-line at SMALLER
// sizes (so the 2-line block always fits in the canvas vertically).
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  baseSize: number,
  weight: number,
): { text: string; size: number }[] {
  const FONT =
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  // Phase 1: try to fit on ONE line, shrinking from baseSize to ~80% of baseSize
  for (let size = baseSize; size >= Math.round(baseSize * 0.8); size -= 4) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    if (ctx.measureText(text).width <= maxWidth) {
      return [{ text, size }];
    }
  }
  // Phase 2: must wrap to 2 lines. Use sizes max ~78% of baseSize so vertical
  // stack fits comfortably in the canvas height.
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
  // Phase 3: last resort — single line at minimum size
  return [{ text, size: Math.round(baseSize * 0.55) }];
}

// ───── Title / outro text textures (two centered lines) ─────
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

  // Auto-fit line 1 to canvas width (was overflowing on long titles)
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

  // Auto-fit line 2
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

  // Line 1 — big bold white
  ctx.fillStyle = "#ffffff";
  ctx.font = `800 ${line1Size}px ${FONT}`;
  ctx.fillText(line1, W / 2, topY + line1Size);

  // Line 2 — smaller, accent color or muted white
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
  game,
  index,
  coverTex,
  labelTex,
  focalIdx,
}: {
  game: Game;
  index: number;
  coverTex: THREE.Texture;
  labelTex: THREE.Texture;
  focalIdx: number;
}) {
  const x = coverX(index);
  const y = coverY(index);
  const z = coverZ(index);
  const rotY = coverRotY(index);

  // Focal index is offset by 1 (waypoint 0 is title), so cover i = waypoint i+1
  const myWaypointIdx = index + 1;
  const d = Math.abs(myWaypointIdx - focalIdx);
  const boost = 0.10 * Math.exp(-d * d * 0.5);
  const scale = 1 + boost;

  const labelY = -COVER_H / 2 - LABEL_GAP - LABEL_PLANE_H / 2;

  return (
    <group position={[x, y, z]} rotation={[0, rotY, 0]}>
      <mesh scale={[scale, scale, 1]} position={[0, 0, -COVER_BORDER_DEPTH]}>
        <boxGeometry
          args={[
            COVER_W + COVER_BORDER * 2,
            COVER_H + COVER_BORDER * 2,
            COVER_BORDER_DEPTH,
          ]}
        />
        <meshStandardMaterial color={COVER_TRIM} roughness={0.6} metalness={0.2} />
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
  rotY,
  texture,
}: {
  position: Vec3;
  rotY: number;
  texture: THREE.Texture;
}) {
  return (
    <group position={position} rotation={[0, rotY, 0]}>
      <mesh>
        <planeGeometry args={[TITLE_PLANE_W, TITLE_PLANE_H]} />
        <meshBasicMaterial map={texture} transparent depthWrite={false} />
      </mesh>
    </group>
  );
}

function CoverRow({ frame }: { frame: number }) {
  const coverPaths = useMemo(
    () => ordered.map((g) => staticFile(`covers/${COVERS[g.rank]}`)),
    [],
  );
  const covers = useTexture(coverPaths);
  const labels = useMemo(() => ordered.map((g) => makeLabel(g)), []);
  const titleTex = useMemo(
    () => makeTitleTexture("TOP 20 BEST-SELLING", "VIDEO GAMES OF ALL TIME", false),
    [],
  );
  const outroTex = useMemo(
    () =>
      makeTitleTexture(
        "THANKS FOR WATCHING",
        "Like & subscribe for more",
        true,
      ),
    [],
  );

  useMemo(() => {
    const planeAspect = COVER_W / COVER_H; // 1.0 (square)
    covers.forEach((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 16;
      const img = t.image as { width?: number; height?: number } | undefined;
      if (img && img.width && img.height) {
        const imgAspect = img.width / img.height;
        if (imgAspect > planeAspect) {
          // Image wider than plane → show full height, crop sides
          const r = planeAspect / imgAspect;
          t.repeat.set(r, 1);
          t.offset.set((1 - r) / 2, 0);
        } else {
          // Image taller than plane → show full width, crop top/bottom
          const r = imgAspect / planeAspect;
          t.repeat.set(1, r);
          t.offset.set(0, (1 - r) / 2);
        }
        t.needsUpdate = true;
      }
    });
  }, [covers]);

  const focal = focalIdxAt(frame);

  return (
    <>
      <TextBoard
        position={[TITLE_X, TITLE_Y, 0]}
        rotY={TITLE_ROT_Y}
        texture={titleTex}
      />
      {ordered.map((g, i) => (
        <FloatingCover
          key={g.rank}
          game={g}
          index={i}
          coverTex={covers[i]}
          labelTex={labels[i]}
          focalIdx={focal}
        />
      ))}
      <TextBoard
        position={[OUTRO_X, OUTRO_Y, 0]}
        rotY={OUTRO_ROT_Y}
        texture={outroTex}
      />
    </>
  );
}

// ───── Starfield + nebula backdrop ─────
function makeSpaceTexture(): THREE.CanvasTexture {
  const W = 4096;
  const H = 2048;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;

  const base = ctx.createLinearGradient(0, 0, W, H);
  base.addColorStop(0, "#0a1424");
  base.addColorStop(0.5, "#040814");
  base.addColorStop(1, "#020410");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);

  const g1 = ctx.createRadialGradient(
    W * 0.18,
    H * 0.28,
    0,
    W * 0.18,
    H * 0.28,
    W * 0.42,
  );
  g1.addColorStop(0, "rgba(140, 180, 240, 0.38)");
  g1.addColorStop(0.4, "rgba(80, 120, 200, 0.12)");
  g1.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = g1;
  ctx.fillRect(0, 0, W, H);

  const g2 = ctx.createRadialGradient(
    W * 0.7,
    H * 0.55,
    0,
    W * 0.7,
    H * 0.55,
    W * 0.3,
  );
  g2.addColorStop(0, "rgba(140, 100, 200, 0.13)");
  g2.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = g2;
  ctx.fillRect(0, 0, W, H);

  // STARS — dimmer (per user request). 1px dots via ImageData.
  const imageData = ctx.getImageData(0, 0, W, H);
  const data = imageData.data;
  for (let i = 0; i < 8000; i++) {
    const px = Math.floor(Math.random() * W);
    const py = Math.floor(Math.random() * H);
    const a = 0.18 + Math.random() * 0.4; // dimmer than before (was 0.4-0.95)
    const idx = (py * W + px) * 4;
    data[idx] = 255;
    data[idx + 1] = 255;
    data[idx + 2] = 255;
    data[idx + 3] = Math.round(a * 255);
  }
  // Brighter stars also dimmed
  for (let i = 0; i < 200; i++) {
    const px = Math.floor(Math.random() * W);
    const py = Math.floor(Math.random() * H);
    const idx = (py * W + px) * 4;
    data[idx] = 255;
    data[idx + 1] = 255;
    data[idx + 2] = 255;
    data[idx + 3] = 180; // ~70% (was 255)
  }
  ctx.putImageData(imageData, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function Backdrop() {
  const space = useMemo(() => makeSpaceTexture(), []);
  return (
    <mesh position={[0, 0, -250]}>
      <planeGeometry args={[1800, 900]} />
      <meshBasicMaterial map={space} />
    </mesh>
  );
}

function Scene({ frame }: { frame: number }) {
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
        <CoverRow frame={frame} />
      </Suspense>
    </>
  );
}

export const BillboardsComposition = () => {
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
          toneMappingExposure: 1.15,
          antialias: true,
          powerPreference: "high-performance",
        }}
      >
        <Suspense fallback={null}>
          <Scene frame={frame} />
        </Suspense>
        <CameraRig frame={frame} />
      </ThreeCanvas>
    </AbsoluteFill>
  );
};
