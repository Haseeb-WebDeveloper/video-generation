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
import { Episode, EpisodeItem } from "./episode";
import { Pillar, SceneBackdrop, buildRuntime } from "./bar-slides";

// Thumbnail = a single still frame of the bar scene composed for clickbait.
// The reference channels (see public/ref/) all use the same pattern: 5
// stocky pillars filling the frame, shot from a left-side 3/4 angle so
// the right faces of the pillars catch the key light and the eye reads
// the row as a 3D staircase rather than a flat chart.
//
// Background is intentionally NOT customised here — we reuse the video's
// SceneBackdrop so the thumbnail and the video share the same world. Any
// backdrop change should happen in bar-slides.tsx so both surfaces stay
// in sync.

// Camera. The reference thumbnails are all shot from a low LEFT-side
// angle, gazing UP at the row — the bar bases get cropped off the
// bottom of the frame and the pillars tower like monoliths. That
// from-below shot is what gives the refs their CTR — pillars feel
// MASSIVE, the eye can't help but follow them up.
//
// Math notes (for future tuning):
//   - 5 bars span 4*SPACING_X + BAR_W = 53 world units edge-to-edge
//   - horizontal FOV ≈ 2*atan(tan(FOV/2) * 16/9)
//   - CAM_Y=4 sits just above the floor; LOOK_Y=30 aims up at the
//     middle of the tallest bar → look-pitch ≈ 27° upward, which
//     pushes the frame-bottom up past y=0 so bar bases drop off frame
//   - CAM_X=-15 puts the camera left of the row; LOOK_X=4 nudges the
//     look-axis right so the rightmost (tallest) bar reads as the
//     anchor of the composition rather than getting crammed against
//     the edge
const THUMB_FOV = 35;
const THUMB_CAM_X = 0;
const THUMB_CAM_Y = 33;
const THUMB_CAM_Z = 58;
const THUMB_LOOK_X = 0;
const THUMB_LOOK_Y = 33;
const THUMB_LOOK_Z = 0;

// How many top items appear on the thumbnail. 5 matches the reference
// channels' density.
const THUMB_TOP_N = 5;

// Bar height range. Combined with the from-below camera, the resulting
// VISIBLE portion of each bar reads as 1:3–1:4 width-to-height (matching
// the refs) even though the true bar aspect is taller — the bottom is
// cropped off frame and we only see the top of each pillar.
//
// MAX 52 is tuned so the tallest bar's flag fits inside the upper edge
// of the frame with a small margin; MIN 22 keeps the shortest bar's
// nameplate above the frame-bottom crop line so its label is readable.
const THUMB_BAR_MIN = 24;
const THUMB_BAR_MAX = 52;

// Load EVERY texture the thumbnail needs (covers + flag PNGs) and only
// resolve when each Texture has its image data populated. Returns a
// Map<url, Texture> when ready, or null while still loading.
//
// delayRender holds Remotion's snapshot until all loads complete.
// continueRender is deferred via setTimeout so React's commit + r3f's
// render of the new scene tree both run BEFORE Remotion captures.
function useLoadedTextures(
  urls: string[],
): Map<string, THREE.Texture> | null {
  const [textures, setTextures] = useState<Map<string, THREE.Texture> | null>(
    null,
  );
  const handleRef = useRef<number | null>(null);
  if (handleRef.current === null && !textures) {
    handleRef.current = delayRender("Loading thumbnail textures");
  }

  useEffect(() => {
    let cancelled = false;
    const map = new Map<string, THREE.Texture>();
    if (urls.length === 0) {
      setTextures(map);
      if (handleRef.current !== null) {
        continueRender(handleRef.current);
        handleRef.current = null;
      }
      return;
    }
    let remaining = urls.length;
    const onDone = () => {
      if (cancelled) return;
      if (--remaining > 0) return;
      setTextures(map);
      setTimeout(() => {
        if (handleRef.current !== null) {
          continueRender(handleRef.current);
          handleRef.current = null;
        }
      }, 250);
    };
    for (const url of urls) {
      const loader = new THREE.TextureLoader();
      loader.load(
        url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 16;
          map.set(url, tex);
          onDone();
        },
        undefined,
        () => {
          onDone();
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [urls]);

  return textures;
}

function ThumbCamera() {
  const camera = useThree((s) => s.camera);
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
    (camera as THREE.PerspectiveCamera).fov = THUMB_FOV;
  }
  camera.position.set(THUMB_CAM_X, THUMB_CAM_Y, THUMB_CAM_Z);
  camera.lookAt(THUMB_LOOK_X, THUMB_LOOK_Y, THUMB_LOOK_Z);
  camera.updateProjectionMatrix();
  return null;
}

// Re-map the runtime's bar heights to the thumbnail-specific MIN/MAX so
// the tallest pillar stays stocky in a still frame. Preserves the
// log-spaced proportionality from buildRuntime.
function remapBarHeights<T extends EpisodeItem & { _barH: number }>(
  items: T[],
): T[] {
  if (items.length === 0) return items;
  let lo = Infinity;
  let hi = -Infinity;
  for (const it of items) {
    if (it._barH < lo) lo = it._barH;
    if (it._barH > hi) hi = it._barH;
  }
  const range = Math.max(hi - lo, 0.001);
  return items.map((it) => ({
    ...it,
    _barH:
      THUMB_BAR_MIN +
      ((it._barH - lo) / range) * (THUMB_BAR_MAX - THUMB_BAR_MIN),
  }));
}

function PillarRow({
  episode,
  topItems,
  textures,
}: {
  episode: Episode;
  topItems: EpisodeItem[];
  textures: Map<string, THREE.Texture>;
}) {
  // Build a runtime from JUST the top-N items so bar heights span the
  // full MIN→MAX range across these 5.
  const top5Episode = useMemo<Episode>(
    () => ({ ...episode, items: topItems }),
    [episode, topItems],
  );
  const runtime = useMemo(() => buildRuntime(top5Episode), [top5Episode]);
  const items = useMemo(() => remapBarHeights(runtime.items), [runtime.items]);

  return (
    <>
      {items.map((item, i) => {
        const coverUrl = item.imagePath ? staticFile(item.imagePath) : null;
        const flagUrl = item.country
          ? staticFile(`flags/${item.country.toLowerCase()}.png`)
          : null;
        const coverTex = coverUrl ? textures.get(coverUrl) ?? null : null;
        const flagTex = flagUrl ? textures.get(flagUrl) ?? null : null;
        if (!coverTex) return null;
        return (
          <Pillar
            key={item.rank}
            index={i}
            N={runtime.N}
            item={item}
            episode={top5Episode}
            coverTex={coverTex}
            flagTex={flagTex}
            frame={0}
          />
        );
      })}
    </>
  );
}

function ThumbScene({
  episode,
  topItems,
  textures,
}: {
  episode: Episode;
  topItems: EpisodeItem[];
  textures: Map<string, THREE.Texture>;
}) {
  return (
    <>
      {/* Same backdrop as the video — keeps thumbnail and video visually
          in sync. Any change to the world (sky, floor, etc.) should
          happen in bar-slides.tsx so both surfaces update together. */}
      <SceneBackdrop />
      {/* Lighting is brighter than the video's scene so the pillars
          read clearly in a still frame at a glance (thumbnails get ~1s
          of attention in a feed). Ambient lifts every face out of dead
          shadow, and the warm key from upper-left + cool key from
          front-right give the cream pillars the directional shaping
          that makes them feel monumental. */}
      <ambientLight intensity={1.15} color="#e8efff" />
      <directionalLight
        position={[-30, 50, 25]}
        intensity={2.4}
        color="#fff4dc"
      />
      <directionalLight
        position={[25, 12, 18]}
        intensity={1.0}
        color="#fff0d0"
      />
      <PillarRow
        episode={episode}
        topItems={topItems}
        textures={textures}
      />
    </>
  );
}

export const BarThumbnailComposition: React.FC<{ episode: Episode }> = ({
  episode,
}) => {
  const { width, height } = useVideoConfig();

  // Top 5 by value, then re-sorted ASC so the bar-row builder puts the
  // smallest pillar on the left and the tallest on the right.
  const topItems = useMemo<EpisodeItem[]>(() => {
    return [...episode.items]
      .sort((a, b) => b.value - a.value)
      .slice(0, THUMB_TOP_N)
      .sort((a, b) => a.value - b.value);
  }, [episode.items]);

  const urls = useMemo(() => {
    const out: string[] = [];
    for (const it of topItems) {
      if (it.imagePath) out.push(staticFile(it.imagePath));
      if (it.country) {
        out.push(staticFile(`flags/${it.country.toLowerCase()}.png`));
      }
    }
    return out;
  }, [topItems]);

  const textures = useLoadedTextures(urls);

  if (!textures) {
    return <AbsoluteFill style={{ background: "#0a0f24" }} />;
  }

  return (
    <AbsoluteFill style={{ background: "#0a0f24" }}>
      <ThreeCanvas
        width={width}
        height={height}
        camera={{ fov: THUMB_FOV, near: 0.1, far: 1500 }}
        dpr={1}
        gl={{
          toneMapping: THREE.ACESFilmicToneMapping,
          // Slightly brighter than the video so the pillars pop against
          // the dark sky in a still.
          toneMappingExposure: 1.2,
          antialias: true,
          powerPreference: "high-performance",
        }}
      >
        <ThumbScene
          episode={episode}
          topItems={topItems}
          textures={textures}
        />
        <ThumbCamera />
      </ThreeCanvas>
    </AbsoluteFill>
  );
};
