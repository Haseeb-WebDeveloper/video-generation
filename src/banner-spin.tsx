import React, { useMemo } from "react";
import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { AbsoluteFill, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
import { StudioEnvironment, ArenaLights } from "./top-battle-slides";

const { fontFamily: INTER } = loadFont();

// YouTube channel banner — 2560×1440. Minimal & clean: a calm row of premium
// spinning tops centred in YouTube's always-visible safe band (center
// 1546×423), with a small wordmark and lots of negative space. Top/bottom of
// the 1440 frame are cropped on desktop/mobile, so nothing important lives
// there. Render via:  node scripts/render-banner.mjs  →  public/banner.png

const WORDMARK = "SPIN BATTLE";

// ── Top geometry (same profile as the video's tops) ──
const TOP_RADIUS = 0.85;
const TOP_HEIGHT = 1.0;
const POINT_Y = -TOP_HEIGHT * 0.5;
const TOP_DISC_Y = 0.44;

// Curated, slightly-muted premium accents (rose/indigo/teal/gold family) so the
// row reads as a tasteful set rather than a loud rainbow.
const ACCENTS = ["#c01f54", "#3a6ea5", "#caa23a", "#3f9d7a", "#6c5bb0"];

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
  g.addColorStop(0, "rgba(54,60,74,0.42)");
  g.addColorStop(0.6, "rgba(54,60,74,0.16)");
  g.addColorStop(1, "rgba(54,60,74,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  _shadowTex = new THREE.CanvasTexture(c);
  return _shadowTex;
}

const NeutralTop: React.FC<{
  position: [number, number, number];
  rotationY: number;
  tilt: number;
  scale: number;
  accent: string;
}> = ({ position, rotationY, tilt, scale, accent }) => {
  const shadow = shadowTexture();
  return (
    <>
      <mesh
        position={[position[0], 0.02, position[2]]}
        rotation={[-Math.PI / 2, 0, 0]}
        scale={scale}
      >
        <planeGeometry args={[TOP_RADIUS * 3.0, TOP_RADIUS * 3.0]} />
        <meshBasicMaterial map={shadow} transparent depthWrite={false} opacity={0.9} />
      </mesh>
      <group position={position} rotation={[tilt, rotationY, tilt * 0.4]} scale={scale}>
        {/* Pearl-chrome shell */}
        <mesh geometry={shellGeometry()}>
          <meshStandardMaterial
            color={"#e4e9f0"}
            roughness={0.34}
            metalness={0.42}
            envMapIntensity={1.0}
            emissive={"#cdd4dd"}
            emissiveIntensity={0.1}
          />
        </mesh>
        {/* Accent ring */}
        <mesh position={[0, TOP_DISC_Y - 0.02, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[TOP_RADIUS * 0.92, TOP_HEIGHT * 0.055, 16, 80]} />
          <meshStandardMaterial color={accent} roughness={0.2} metalness={0.92} envMapIntensity={1.5} />
        </mesh>
        {/* Polished accent disc (no flag — brand-neutral) */}
        <mesh position={[0, TOP_DISC_Y + 0.02, 0]}>
          <cylinderGeometry args={[TOP_RADIUS * 0.8, TOP_RADIUS * 0.8, 0.06, 64]} />
          <meshStandardMaterial color={accent} roughness={0.28} metalness={0.7} envMapIntensity={1.2} />
        </mesh>
        {/* Gold stem + bead */}
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

// Five tops in a gentle row. The centre three sit inside the mobile safe area;
// the outer two only appear on desktop/TV. Slight scale/depth falloff toward
// the edges keeps the eye on the centre.
const ROW: { x: number; z: number; scale: number; rotY: number; tilt: number }[] = [
  { x: -5.7, z: -0.8, scale: 0.86, rotY: 2.3, tilt: 0.06 },
  { x: -2.95, z: 0.2, scale: 0.96, rotY: 0.6, tilt: -0.05 },
  { x: 0.0, z: 1.0, scale: 1.06, rotY: 1.5, tilt: 0.04 },
  { x: 2.95, z: 0.2, scale: 0.96, rotY: 4.1, tilt: -0.06 },
  { x: 5.7, z: -0.8, scale: 0.86, rotY: 5.0, tilt: 0.06 },
];

const BannerCamera: React.FC = () => {
  const camera = useThree((s) => s.camera);
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
    (camera as THREE.PerspectiveCamera).fov = 24;
  }
  camera.position.set(0, 3.4, 18.5);
  camera.lookAt(0, 0.55, 0);
  camera.updateProjectionMatrix();
  return null;
};

const BannerScene: React.FC = () => {
  return (
    <>
      <StudioEnvironment />
      <ArenaLights />
      {ROW.map((t, i) => (
        <NeutralTop
          key={i}
          position={[t.x, (TOP_HEIGHT / 2) * t.scale, t.z]}
          rotationY={t.rotY}
          tilt={t.tilt}
          scale={t.scale}
          accent={ACCENTS[i % ACCENTS.length]}
        />
      ))}
    </>
  );
};

export const BannerComposition: React.FC = () => {
  const { width, height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ fontFamily: INTER }}>
      {/* Premium light studio gradient — clean, no clutter. */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(120% 120% at 50% 38%, #eef1f5 0%, #d9dfe8 46%, #c3ccd8 100%)",
        }}
      />
      <ThreeCanvas
        width={width}
        height={height}
        gl={{
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.16,
          antialias: true,
          alpha: true,
        }}
      >
        <BannerScene />
        <BannerCamera />
      </ThreeCanvas>
      {/* Very soft vignette to settle the edges. */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse 80% 90% at 50% 50%, rgba(0,0,0,0) 55%, rgba(40,48,60,0.14) 100%)",
          pointerEvents: "none",
        }}
      />
      {/* Minimal wordmark, kept inside the safe band (≈ y 508–931 of 1440) so
          it's never cropped on desktop/mobile. Anchored at 60% of height. */}
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <div
          style={{
            position: "absolute",
            top: "60%",
            left: 0,
            right: 0,
            textAlign: "center",
            fontSize: width * 0.025,
            fontWeight: 700,
            letterSpacing: width * 0.004,
            color: "#2b2533",
            opacity: 0.9,
            textTransform: "uppercase",
          }}
        >
          {WORDMARK}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
