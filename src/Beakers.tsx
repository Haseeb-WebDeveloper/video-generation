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
const BEAKER_RADIUS = 1.7;
const BEAKER_HEIGHT = 12;
const BEAKER_WALL = 0.06;
const BEAKER_SPACING = 5.6;
const MAX_FILL = 11;
const MIN_FILL = 2.0;
const COVER_W = 2.2;
const COVER_H = 3.3;
const FOV = 32;

// ───── Palette ─────
const BG_COLOR = "#0a1322";
const BENCH_COLOR = "#1d2a42";
const GLASS_COLOR = "#dde8f5";
const TEXT_LIGHT = "#e5ecf6";
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

// Display order: #20 left → #1 right
const ordered = [...games].sort((a, b) => b.rank - a.rank);
const N = ordered.length;
const maxValue = Math.max(...games.map((g) => g.copiesMillions));

// Square-root scaling so the small values still produce visible fills.
function fillForValue(m: number): number {
  const t = Math.sqrt(m / maxValue);
  return MIN_FILL + (MAX_FILL - MIN_FILL) * t;
}

const beakerXAt = (i: number) =>
  i * BEAKER_SPACING - ((N - 1) * BEAKER_SPACING) / 2;

const targetFills = ordered.map((g) => fillForValue(g.copiesMillions));

function formatValue(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)}B`;
  return `${m}M`;
}

type Vec3 = [number, number, number];

// ───── Pacing (60fps) ─────
const PHASE_INTRO = 80;   // ~1.3s — opening dolly
const PER_BEAKER = 60;    // 1.0s — camera time per beaker
const FILL_LEAD = 25;     // beaker starts filling 25 frames before camera centers
const FILL_DUR = 40;      // ~0.67s fill animation
const PHASE_HERO = 150;   // 2.5s hold on #1
const PHASE_OUTRO = 130;  // ~2.17s pull-back

const TRAVEL_TOTAL = N * PER_BEAKER;
export const TOTAL_FRAMES =
  PHASE_INTRO + TRAVEL_TOTAL + PHASE_HERO + PHASE_OUTRO + 30;

// Frame at which camera centers on beaker i during travel
const arrivalFrame = (i: number) => PHASE_INTRO + (i + 1) * PER_BEAKER;

// Camera focus pose for beaker i (camera level with mid-beaker, looking at it)
const CAM_Y = 5.5; // eye level with the lower-mid of the beaker
const CAM_DIST = 14;
const LOOK_Y = 5.5;

function focusPose(i: number): { camPos: Vec3; lookAt: Vec3 } {
  const x = beakerXAt(i);
  return {
    camPos: [x + 0.6, CAM_Y, CAM_DIST],
    lookAt: [x, LOOK_Y, 0],
  };
}

const startPose = {
  camPos: [beakerXAt(0) - 8, CAM_Y + 1, CAM_DIST + 4] as Vec3,
  lookAt: [beakerXAt(0), LOOK_Y, 0] as Vec3,
};

const outroPose = {
  camPos: [beakerXAt(N - 1) + 0.6, CAM_Y + 1.5, CAM_DIST + 8] as Vec3,
  lookAt: [beakerXAt(N - 1), LOOK_Y + 1, 0] as Vec3,
};

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

// Fill progress (0..1) for beaker i at given frame
function fillProgressFor(i: number, frame: number): number {
  const arrive = arrivalFrame(i);
  const fillStart = arrive - FILL_LEAD;
  const t = (frame - fillStart) / FILL_DUR;
  return smoothstep(t);
}

function CameraRig({ frame }: { frame: number }) {
  const camera = useThree((s) => s.camera);

  let pos: Vec3;
  let look: Vec3;

  if (frame < PHASE_INTRO) {
    const t = frame / PHASE_INTRO;
    const e = easeInOut(t);
    pos = lerpVec3(startPose.camPos, focusPose(0).camPos, e);
    look = lerpVec3(startPose.lookAt, focusPose(0).lookAt, e);
  } else if (frame < PHASE_INTRO + TRAVEL_TOTAL) {
    // Continuous slide between focusPoses
    const tNorm = (frame - PHASE_INTRO) / PER_BEAKER;
    const a = Math.min(Math.floor(tNorm), N - 1);
    const b = Math.min(a + 1, N - 1);
    const f = smoothstep(tNorm - a);
    pos = lerpVec3(focusPose(a).camPos, focusPose(b).camPos, f);
    look = lerpVec3(focusPose(a).lookAt, focusPose(b).lookAt, f);
  } else if (frame < PHASE_INTRO + TRAVEL_TOTAL + PHASE_HERO) {
    pos = focusPose(N - 1).camPos;
    look = focusPose(N - 1).lookAt;
  } else {
    const t = clamp01(
      (frame - PHASE_INTRO - TRAVEL_TOTAL - PHASE_HERO) / PHASE_OUTRO,
    );
    const e = easeInOut(t);
    pos = lerpVec3(focusPose(N - 1).camPos, outroPose.camPos, e);
    look = lerpVec3(focusPose(N - 1).lookAt, outroPose.lookAt, e);
  }

  // Subtle handheld drift
  const time = frame / 60;
  const dx = Math.sin(time * 0.7) * 0.04;
  const dy = Math.cos(time * 0.55) * 0.03;
  const dz = Math.sin(time * 0.45) * 0.03;

  camera.position.set(pos[0] + dx, pos[1] + dy, pos[2] + dz);
  camera.lookAt(look[0], look[1], look[2]);
  camera.updateProjectionMatrix();
  return null;
}

// ───── Label texture: rank header + name + value, transparent canvas ─────
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

  // Wrap name to fit
  const nameLines = wrapText(ctx, game.title, LABEL_W * 0.92, nameMaxSize, 600);
  const actualName = nameLines[0].size;
  const nameLineH = actualName * 1.1;

  const gap1 = LABEL_H * 0.025;
  const gap2 = LABEL_H * 0.035;

  const blockH =
    rankSize + gap1 + nameLines.length * nameLineH + gap2 + valueSize;
  const topY = (LABEL_H - blockH) / 2;

  // Rank header
  ctx.fillStyle = ACCENT;
  ctx.font = `700 ${rankSize}px ${FONT}`;
  drawSpaced(
    ctx,
    `RANK ${game.rank}`,
    LABEL_W / 2,
    topY + rankSize,
    rankSize * 0.18,
  );

  // Name
  ctx.fillStyle = TEXT_LIGHT;
  ctx.font = `600 ${actualName}px ${FONT}`;
  const nameY = topY + rankSize + gap1 + actualName;
  for (let i = 0; i < nameLines.length; i++) {
    ctx.fillText(nameLines[i].text, LABEL_W / 2, nameY + i * nameLineH);
  }

  // Value
  ctx.fillStyle = TEXT_LIGHT;
  ctx.font = `700 ${valueSize}px ${FONT}`;
  const valueY =
    nameY + (nameLines.length - 1) * nameLineH + gap2 + valueSize;
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

// ───── Beaker (glass cylinder + liquid + cover inside) ─────
function Beaker({
  game,
  index,
  fillProgress,
  coverTex,
  labelTex,
}: {
  game: Game;
  index: number;
  fillProgress: number;
  coverTex: THREE.Texture;
  labelTex: THREE.Texture;
}) {
  const x = beakerXAt(index);
  const target = targetFills[index];
  const liquidH = Math.max(0.001, target * fillProgress);
  // Cover sits at the middle of the FINAL liquid (not current) — stays put
  // visually as the liquid rises around it.
  const coverY = target * 0.55;

  return (
    <group position={[x, 0, 0]}>
      {/* Bench under the beaker (small plate) */}
      <mesh position={[0, -0.05, 0]}>
        <cylinderGeometry args={[BEAKER_RADIUS + 0.4, BEAKER_RADIUS + 0.5, 0.1, 32]} />
        <meshStandardMaterial color={BENCH_COLOR} roughness={0.7} metalness={0.1} />
      </mesh>

      {/* Glass cylinder — open top, thin walls, double-sided */}
      <mesh position={[0, BEAKER_HEIGHT / 2, 0]}>
        <cylinderGeometry
          args={[
            BEAKER_RADIUS,
            BEAKER_RADIUS,
            BEAKER_HEIGHT,
            48,
            1,
            true, // openEnded
          ]}
        />
        <meshPhysicalMaterial
          color={GLASS_COLOR}
          transparent
          opacity={0.18}
          roughness={0.05}
          metalness={0}
          transmission={0.6}
          ior={1.45}
          thickness={0.3}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Glass bottom */}
      <mesh position={[0, 0.04, 0]}>
        <cylinderGeometry args={[BEAKER_RADIUS, BEAKER_RADIUS, 0.08, 48]} />
        <meshPhysicalMaterial
          color={GLASS_COLOR}
          transparent
          opacity={0.4}
          roughness={0.1}
          metalness={0}
          transmission={0.5}
          ior={1.45}
        />
      </mesh>

      {/* Liquid */}
      <mesh position={[0, liquidH / 2 + 0.05, 0]}>
        <cylinderGeometry
          args={[
            BEAKER_RADIUS - BEAKER_WALL,
            BEAKER_RADIUS - BEAKER_WALL,
            liquidH,
            48,
          ]}
        />
        <meshStandardMaterial
          color={game.color}
          transparent
          opacity={0.92}
          roughness={0.35}
          metalness={0.05}
        />
      </mesh>

      {/* Liquid surface highlight (small bright disc on top) */}
      <mesh
        position={[0, liquidH + 0.06, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <circleGeometry args={[BEAKER_RADIUS - BEAKER_WALL - 0.02, 48]} />
        <meshBasicMaterial color={game.color} transparent opacity={0.55} />
      </mesh>

      {/* Cover suspended INSIDE the beaker */}
      <mesh position={[0, coverY, 0]}>
        <planeGeometry args={[COVER_W, COVER_H]} />
        <meshBasicMaterial map={coverTex} transparent />
      </mesh>

      {/* Label below beaker */}
      <mesh position={[0, -1.6, 0.1]}>
        <planeGeometry args={[5.0, 1.9]} />
        <meshBasicMaterial map={labelTex} transparent depthWrite={false} />
      </mesh>
    </group>
  );
}

function BeakerRow({ frame }: { frame: number }) {
  const coverPaths = useMemo(
    () => ordered.map((g) => staticFile(`covers/${COVERS[g.rank]}`)),
    [],
  );
  const covers = useTexture(coverPaths);
  const labels = useMemo(() => ordered.map((g) => makeLabel(g)), []);

  useMemo(() => {
    covers.forEach((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 16;
    });
  }, [covers]);

  return (
    <>
      {ordered.map((g, i) => (
        <Beaker
          key={g.rank}
          game={g}
          index={i}
          fillProgress={fillProgressFor(i, frame)}
          coverTex={covers[i]}
          labelTex={labels[i]}
        />
      ))}
    </>
  );
}

function Hall() {
  return (
    <group>
      {/* Back wall — solid dark navy, very subtle gradient feel */}
      <mesh position={[0, 30, -25]}>
        <planeGeometry args={[400, 80]} />
        <meshBasicMaterial color={BG_COLOR} />
      </mesh>

      {/* Bench surface — long flat plate the beakers sit on */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.001, 0]}
      >
        <planeGeometry args={[400, 16]} />
        <meshStandardMaterial
          color={BENCH_COLOR}
          roughness={0.8}
          metalness={0.05}
        />
      </mesh>

      {/* Floor in front of bench (extends camera-side) */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.05, 12]}
      >
        <planeGeometry args={[400, 60]} />
        <meshBasicMaterial color={BG_COLOR} />
      </mesh>
    </group>
  );
}

function Scene({ frame }: { frame: number }) {
  return (
    <>
      <color attach="background" args={[BG_COLOR]} />
      <fog attach="fog" args={[BG_COLOR, 30, 90]} />

      {/* Soft ambient */}
      <ambientLight intensity={0.55} color="#cdd9eb" />

      {/* Key light from above (museum spotlight feel) */}
      <directionalLight
        position={[5, 30, 12]}
        intensity={1.2}
        color="#ffffff"
      />

      {/* Cool rim from behind */}
      <directionalLight
        position={[0, 10, -15]}
        intensity={0.6}
        color="#7eb5f0"
      />

      {/* Warm fill from camera side */}
      <directionalLight
        position={[-10, 6, 20]}
        intensity={0.35}
        color="#ffd6a8"
      />

      <Hall />
      <Suspense fallback={null}>
        <BeakerRow frame={frame} />
      </Suspense>
    </>
  );
}

export const BeakersComposition = () => {
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
          toneMappingExposure: 1.1,
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
