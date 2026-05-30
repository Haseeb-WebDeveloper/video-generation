import React, { useEffect, useMemo, useRef, useState } from "react";
import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  AbsoluteFill,
  continueRender,
  delayRender,
  staticFile,
  useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
import { Episode, EpisodeItem } from "./episode";
import { Arena, ArenaLights, StudioEnvironment, Backdrop } from "./top-battle-slides";

const { fontFamily: INTER } = loadFont();

// Dynamic thumbnail for the spin-battle videos: each episode's flag-tops
// scattered on a clean light studio floor, with the big title on top. One still
// frame. Render via:  npx remotion still <slug>-spin-thumb out/thumbnails/<slug>.png
// then set "thumbnailPath" on the episode so publish-episode uploads it.

const THUMB_TITLE = "COUNTRY SPIN BATTLE";

// ── Top geometry / palette (kept visually in sync with top-battle-slides) ──
const TOP_RADIUS = 0.85;
const TOP_HEIGHT = 1.0;
const POINT_Y = -TOP_HEIGHT * 0.5;
const TOP_DISC_Y = 0.44;

const ACCENT_PALETTE = [
  "#c1121f", "#1d4ed8", "#059669", "#d97706", "#7c3aed", "#be185d",
  "#0d9488", "#b45309", "#dc2626", "#0891b2", "#ea580c", "#4f46e5",
  "#65a30d", "#e11d48", "#0e7490", "#a21caf", "#0369a1", "#ca8a04",
  "#16a34a", "#9333ea", "#b91c1c", "#c2410c", "#3730a3", "#15803d",
  "#155e75", "#92400e", "#6b21a8", "#4d7c0f", "#9f1239", "#db2777",
];

let _shellGeo: THREE.LatheGeometry | null = null;
function shellGeometry(): THREE.LatheGeometry {
  if (_shellGeo) return _shellGeo;
  const R = TOP_RADIUS;
  const pts = [
    new THREE.Vector2(0.0, POINT_Y),
    new THREE.Vector2(0.34 * R, POINT_Y + 0.14),
    new THREE.Vector2(0.62 * R, POINT_Y + 0.32),
    new THREE.Vector2(0.86 * R, POINT_Y + 0.52),
    new THREE.Vector2(R, TOP_DISC_Y - 0.14),
    new THREE.Vector2(R, TOP_DISC_Y - 0.03),
    new THREE.Vector2(R * 0.82, TOP_DISC_Y + 0.02),
    new THREE.Vector2(0.0, TOP_DISC_Y + 0.02),
  ];
  _shellGeo = new THREE.LatheGeometry(pts, 72);
  _shellGeo.computeVertexNormals();
  return _shellGeo;
}

let _shadowTex: THREE.CanvasTexture | null = null;
function shadowTexture(): THREE.CanvasTexture {
  if (_shadowTex) return _shadowTex;
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(40,40,55,0.5)");
  g.addColorStop(0.6, "rgba(40,40,55,0.22)");
  g.addColorStop(1, "rgba(40,40,55,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  _shadowTex = new THREE.CanvasTexture(c);
  return _shadowTex;
}


// Load all flag textures; hold the render until ready (mirrors thumbnail-bar).
function useLoadedTextures(urls: string[]): Map<string, THREE.Texture> | null {
  const [textures, setTextures] = useState<Map<string, THREE.Texture> | null>(null);
  const handleRef = useRef<number | null>(null);
  if (handleRef.current === null && !textures) {
    handleRef.current = delayRender("Loading thumbnail flags");
  }
  useEffect(() => {
    let cancelled = false;
    const map = new Map<string, THREE.Texture>();
    let remaining = urls.length;
    const done = () => {
      if (cancelled) return;
      if (--remaining > 0) return;
      setTextures(map);
      setTimeout(() => {
        if (handleRef.current !== null) {
          continueRender(handleRef.current);
          handleRef.current = null;
        }
      }, 200);
    };
    if (urls.length === 0) { done(); return; }
    for (const url of urls) {
      new THREE.TextureLoader().load(
        url,
        (t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; map.set(url, t); done(); },
        undefined,
        () => done(),
      );
    }
    return () => { cancelled = true; };
  }, [urls]);
  return textures;
}

const StaticTop: React.FC<{
  position: [number, number, number];
  rotationY: number;
  tilt: number;
  flag: THREE.Texture | null;
  accent: string;
}> = ({ position, rotationY, tilt, flag, accent }) => {
  const shadow = shadowTexture();
  return (
    <>
      <mesh position={[position[0], 0.02, position[2]]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[TOP_RADIUS * 2.8, TOP_RADIUS * 2.8]} />
        <meshBasicMaterial map={shadow} transparent depthWrite={false} opacity={0.85} />
      </mesh>
      <group position={position} rotation={[tilt, rotationY, tilt * 0.5]}>
        <mesh geometry={shellGeometry()}>
          <meshStandardMaterial
            color={"#e2e7ee"}
            roughness={0.42}
            metalness={0.28}
            envMapIntensity={0.7}
            emissive={"#cdd4dd"}
            emissiveIntensity={0.14}
          />
        </mesh>
        <mesh position={[0, TOP_DISC_Y - 0.02, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[TOP_RADIUS * 0.92, TOP_HEIGHT * 0.055, 14, 72]} />
          <meshStandardMaterial color={accent} roughness={0.22} metalness={0.9} envMapIntensity={1.4} />
        </mesh>
        <mesh position={[0, TOP_DISC_Y + 0.02, 0]}>
          <cylinderGeometry args={[TOP_RADIUS * 0.8, TOP_RADIUS * 0.8, 0.06, 64]} />
          {flag ? (
            <meshBasicMaterial map={flag} toneMapped={false} />
          ) : (
            <meshBasicMaterial color={accent} toneMapped={false} />
          )}
        </mesh>
        <mesh position={[0, TOP_DISC_Y + 0.13, 0]}>
          <cylinderGeometry args={[TOP_RADIUS * 0.1, TOP_RADIUS * 0.12, 0.22, 24]} />
          <meshStandardMaterial color={"#e6b54a"} roughness={0.22} metalness={1.0} />
        </mesh>
        <mesh position={[0, TOP_DISC_Y + 0.25, 0]}>
          <sphereGeometry args={[TOP_RADIUS * 0.11, 20, 16]} />
          <meshStandardMaterial color={"#e6b54a"} roughness={0.22} metalness={1.0} />
        </mesh>
      </group>
    </>
  );
};

// Scatter positions (x, z) for up to ~12 tops — three rows receding, jittered,
// front-centre most prominent. Deterministic so a slug always lays out the same.
// Positions on the real play board (x ∈ ±10, z ∈ ±5.6) — a tight cluster so
// the tops fill the frame like a live battle moment.
const LAYOUT: [number, number][] = [
  [-4.0, 4.0], [0.1, 4.5], [4.1, 3.9],
  [-5.6, 1.0], [-1.85, 0.8], [1.9, 1.0], [5.6, 0.8],
  [-3.6, -2.2], [0.4, -2.6], [3.7, -2.1],
  [-1.6, 5.9], [2.0, 6.0],
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ThumbCamera: React.FC = () => {
  const camera = useThree((s) => s.camera);
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
    (camera as THREE.PerspectiveCamera).fov = 38;
  }
  camera.position.set(0, 7.4, 15.5);
  camera.lookAt(0, 0.9, 0.4);
  camera.updateProjectionMatrix();
  return null;
};

const ThumbScene: React.FC<{ items: EpisodeItem[]; textures: Map<string, THREE.Texture> }> = ({
  items,
  textures,
}) => {
  const rand = useMemo(() => rng(0x51a2 + items.length), [items.length]);
  return (
    <>
      {/* The REAL arena from the video — same floor grid, board, walls, cove,
          lighting — so the thumbnail looks like an actual game moment. */}
      <color attach="background" args={["#aab5c2"]} />
      <fog attach="fog" args={["#adb8c5", 36, 130]} />
      <Backdrop />
      <StudioEnvironment />
      <ArenaLights />
      <Arena />
      {items.map((it, i) => {
        const pos = LAYOUT[i % LAYOUT.length];
        const flagUrl = it.imagePath
          ? staticFile(it.imagePath)
          : staticFile(`flags/${(it.country ?? "us").toLowerCase()}.png`);
        const flag = textures.get(flagUrl) ?? null;
        return (
          <StaticTop
            key={i}
            position={[pos[0], TOP_HEIGHT / 2, pos[1]]}
            rotationY={rand() * Math.PI * 2}
            tilt={(rand() - 0.5) * 0.18}
            flag={flag}
            accent={ACCENT_PALETTE[i % ACCENT_PALETTE.length]}
          />
        );
      })}
    </>
  );
};

export const SpinThumbnailComposition: React.FC<{ episode: Episode }> = ({ episode }) => {
  const { width, height } = useVideoConfig();
  const items = useMemo(() => episode.items.slice(0, LAYOUT.length), [episode.items]);
  const urls = useMemo(
    () =>
      items.map((it) =>
        it.imagePath
          ? staticFile(it.imagePath)
          : staticFile(`flags/${(it.country ?? "us").toLowerCase()}.png`),
      ),
    [items],
  );
  const textures = useLoadedTextures(urls);
  if (!textures) return <AbsoluteFill style={{ background: "#aab5c2" }} />;
  return (
    <AbsoluteFill style={{ background: "#aab5c2", fontFamily: INTER }}>
      <ThreeCanvas
        width={width}
        height={height}
        gl={{ toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.18, antialias: true }}
      >
        <ThumbScene items={items} textures={textures} />
        <ThumbCamera />
      </ThreeCanvas>
      {/* Same vignette as the video so it reads as the real scene. */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse 66% 74% at 50% 47%, rgba(0,0,0,0) 30%, rgba(24,33,46,0.22) 62%, rgba(13,19,29,0.55) 100%)",
          pointerEvents: "none",
        }}
      />
      {/* Title — theme rose, plain text (no background, no shadow), top. */}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-start", pointerEvents: "none" }}>
        <div
          style={{
            marginTop: height * 0.045,
            textAlign: "center",
            fontSize: width * 0.058,
            fontWeight: 800,
            letterSpacing: width * 0.0006,
            color: "#a60235",
            lineHeight: 1,
            whiteSpace: "nowrap",
            textTransform: "uppercase",
          }}
        >
          {THUMB_TITLE}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
