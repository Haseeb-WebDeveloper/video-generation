import React, { useMemo } from "react";
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
import { Episode, EpisodeItem } from "./episode";
import {
  Pillar,
  buildRuntime,
} from "./bar-slides";

// Load a THREE.Texture and tie it into Remotion's render lifecycle.
//
// Three things must coordinate for a still render to actually show the
// pixel data:
//
// 1. `delayRender` is called SYNCHRONOUSLY during component render so
//    Remotion blocks the snapshot until continueRender fires.
// 2. `invalidate()` (from r3f) is called when the load completes — r3f's
//    "demand" frameloop (set by @remotion/three) only renders on tree
//    changes or explicit invalidation, so without this the GPU never
//    gets the now-decoded image data.
// 3. `continueRender` is deferred two rAFs after the load callback so
//    r3f's re-render has time to paint the new texture to the canvas
//    BEFORE Remotion screenshots the page.
function useDelayedTexture(url: string | null): THREE.Texture | null {
  const invalidate = useThree((s) => s.invalidate);
  return useMemo(() => {
    if (!url) return null;
    const handle = delayRender(`Loading texture: ${url}`);
    const loader = new THREE.TextureLoader();
    const tex = loader.load(
      url,
      () => {
        invalidate();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => continueRender(handle));
        });
      },
      undefined,
      () => continueRender(handle), // unblock Remotion even on load failure
    );
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 16;
    return tex;
  }, [url, invalidate]);
}

// Thumbnail = a single still frame of the bar scene composed for clickbait.
// The reference channels (see public/ref/) all use the same pattern: 4–5
// pillars in dramatic perspective on the same backdrop as the video, with
// every nameplate and value fully visible (no blur, no curiosity gap —
// the data IS the hook). This composition mirrors that.
//
// The scene is built from the existing bar-slides Pillar component so any
// visual change there (palette, materials, nameplate style, hero-flag
// behavior) automatically propagates to thumbnails — no parallel set of
// assets to maintain.

// Camera tuned to fit all 5 pillars from the LOW-FRONT-RIGHT, looking up
// and slightly toward the tallest bar on the right. Camera Y is below the
// shortest bar's TOP so the row reads as a row of monuments looming above
// — the same "looking up at it" framing every reference thumbnail uses.
// FOV is wider than the video's 34° because we need to fit five bars
// (Y span 0→80, X span ±26) in one frame at a viable distance.
const THUMB_FOV = 50;
const THUMB_CAM_X = 6;
const THUMB_CAM_Y = 8;
const THUMB_CAM_Z = 105;
const THUMB_LOOK_X = -2;
const THUMB_LOOK_Y = 38;
const THUMB_LOOK_Z = 0;

// How many top items appear on the thumbnail. 5 matches the reference
// channels' density — enough bars to show "ascending stakes" without
// crowding the frame.
const THUMB_TOP_N = 5;

// Delay-rendered backdrop — bg-2.jpg gated by delayRender so the still
// snapshot waits for the image to decode. Without this, the bg quad
// renders with an empty texture (transparent) and the AbsoluteFill
// background bleeds through.
function ThumbBackdrop() {
  const tex = useDelayedTexture(staticFile("bg-2.jpg"));
  if (!tex) return null;
  return <primitive attach="background" object={tex} />;
}

function ThumbCamera() {
  const camera = useThree((s) => s.camera);
  // PerspectiveCamera (the R3F default). Set fov on it directly — the
  // top-level camera prop sets initial value but doesn't react to changes
  // after mount, so we re-apply here for safety.
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
    (camera as THREE.PerspectiveCamera).fov = THUMB_FOV;
  }
  camera.position.set(THUMB_CAM_X, THUMB_CAM_Y, THUMB_CAM_Z);
  camera.lookAt(THUMB_LOOK_X, THUMB_LOOK_Y, THUMB_LOOK_Z);
  camera.updateProjectionMatrix();
  return null;
}

// One pillar plus its textures. Wrapped in a child component so the two
// useDelayedTexture calls live at fixed positions in the hook order —
// keeping them inside a `.map()` in the parent would call hooks in a
// loop, which React forbids.
function PillarWithTextures({
  episode,
  item,
  index,
  N,
}: {
  episode: Episode;
  item: EpisodeItem & { _barH: number };
  index: number;
  N: number;
}) {
  const coverUrl = item.imagePath ? staticFile(item.imagePath) : null;
  const flagUrl = item.country
    ? staticFile(`flags/${item.country.toLowerCase()}.png`)
    : null;
  const coverTex = useDelayedTexture(coverUrl);
  const flagTex = useDelayedTexture(flagUrl);
  // Pillar requires a non-null coverTex (used for the box-front cover card
  // OR the hero-flag plane). Skip rendering until it resolves.
  if (!coverTex) return null;
  return (
    <Pillar
      index={index}
      N={N}
      item={item}
      episode={episode}
      coverTex={coverTex}
      flagTex={flagTex}
      frame={0}
    />
  );
}

function PillarRow({
  episode,
  topItems,
}: {
  episode: Episode;
  topItems: EpisodeItem[];
}) {
  // Build a runtime from JUST the top-N items so bar heights span the
  // full MIN→MAX range across these 5 (instead of being squashed into the
  // tiny upper slice they'd occupy if scaled against all 20 items).
  // The result: the staircase reads more dramatically — the tallest bar
  // dwarfs the shortest visible bar by the full template range.
  const top5Episode = useMemo<Episode>(
    () => ({ ...episode, items: topItems }),
    [episode, topItems],
  );
  const runtime = useMemo(() => buildRuntime(top5Episode), [top5Episode]);

  return (
    <>
      {runtime.items.map((item, i) => (
        <PillarWithTextures
          key={item.rank}
          index={i}
          N={runtime.N}
          item={item}
          episode={top5Episode}
        />
      ))}
    </>
  );
}

function ThumbScene({ episode }: { episode: Episode }) {
  // Top 5 by value, sorted ASC so the bar-row builder puts the smallest
  // pillar on the left and the tallest on the right — same convention the
  // video uses, so the thumbnail composition reads as a snapshot of the
  // video's climax.
  const topItems = useMemo<EpisodeItem[]>(() => {
    return [...episode.items]
      .sort((a, b) => b.value - a.value)
      .slice(0, THUMB_TOP_N)
      .sort((a, b) => a.value - b.value);
  }, [episode.items]);

  return (
    <>
      <ThumbBackdrop />
      <ambientLight intensity={0.9} color="#cdd4ee" />
      <directionalLight
        position={[-30, 50, 25]}
        intensity={1.0}
        color="#e8eaff"
      />
      <directionalLight
        position={[20, 10, 15]}
        intensity={0.35}
        color="#f5a64a"
      />
      <PillarRow episode={episode} topItems={topItems} />
    </>
  );
}

export const BarThumbnailComposition: React.FC<{ episode: Episode }> = ({
  episode,
}) => {
  const { width, height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: "#0a0f24" }}>
      <ThreeCanvas
        width={width}
        height={height}
        camera={{ fov: THUMB_FOV, near: 0.1, far: 800 }}
        dpr={1}
        gl={{
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.1,
          antialias: true,
          powerPreference: "high-performance",
        }}
      >
        <ThumbScene episode={episode} />
        <ThumbCamera />
      </ThreeCanvas>
    </AbsoluteFill>
  );
};
