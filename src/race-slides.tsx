import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import { Suspense, useMemo } from "react";
import {
  AbsoluteFill,
  Audio,
  continueRender,
  delayRender,
  Easing,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
import { Episode } from "./episode";

const { fontFamily: INTER } = loadFont();

// ─── Track constants. MUST stay in sync with scripts/race-roll.mjs.
// If you change either side the existing bakes are invalidated. We don't
// import from race-roll because it's a Node script (.mjs); the cost of
// duplication is small for ~15 constants. TRACK_TILT_DEG only matters in
// the simulator (it sets the gravity vector); the visual scene leaves the
// floor flat, so we don't store it here.
const TRACK_LEN = 110;
const TRACK_HALF_Z = 12;
const FLOOR_Y = 0;
const WALL_HEIGHT = 4;
const FINISH_X = TRACK_LEN - 5;
const BALL_R = 0.7;
const PEG_R = 0.45;
const PEG_H = 2.0;
const PEG_X_MIN = 15;
const PEG_X_MAX = TRACK_LEN - 18;
const PEG_ROW_DX = 9;
const PEG_ROW_DZ = 6;

const FPS = 60;
const COUNTDOWN_FRAMES = 3 * FPS; // 3s pre-race grid hold + 3-2-1-GO
const PODIUM_FRAMES = 6 * FPS; // 6s podium hold after last ball settles
const POST_FINISH_HOLD_FRAMES = 2 * FPS; // 2s after #1 crosses before podium camera
const AUDIO_FADE_FRAMES = 90; // matches flow/bar templates so post-mux fade is identical

// Per-ball palette. Used only as a fallback when an item has no imagePath
// (the normal case has covers via the build-episode pipeline). Tuned to sit
// well against the LIGHT arena backdrop — mid-saturation, mid-lightness,
// no fluorescent neons. Indexed by item index modulo length.
const BALL_PALETTE = [
  "#d94d4d",
  "#e0883a",
  "#c9b736",
  "#5fa84a",
  "#34a8a1",
  "#3d7fd1",
  "#7a5acf",
  "#cc5aa3",
  "#b25034",
  "#8aa83a",
  "#34a87a",
  "#3473b7",
  "#9c46b7",
  "#c79334",
  "#34b574",
  "#bf3b6a",
  "#34a8a8",
  "#b56e34",
  "#85a834",
  "#3454b7",
  "#bf3434",
  "#bfa334",
  "#34a834",
  "#a8348a",
  "#34a890",
  "#a85f34",
  "#5f34a8",
  "#3470a8",
  "#a83470",
  "#70a834",
  "#a834a8",
  "#34a8c4",
];

// ─── Arena palette ─────────────────────────────────────────────
// Light "modern product render" look — see reference screenshot.
// Background is a calm cool grey; floor is bright off-white; rails are
// muted teal metal. Avoid any single-channel neons; this is meant to read
// as a real space, not a sci-fi corridor.
const COLOR_BG = "#cfdde0";
const COLOR_FLOOR = "#ececee";
const COLOR_FLOOR_OUTSIDE = "#b6c6c9";
const COLOR_RAIL = "#7fa5ad";
const COLOR_RAIL_TOP = "#cf5050";
const COLOR_PEG = "#dadddf";
const COLOR_BACK_WALL = "#445e63";

const RAIL_POST_SPACING = 1.6;
const RAIL_POST_R = 0.13;
const RAIL_TOP_THICKNESS = 0.35;
const RAIL_TOP_HEIGHT = WALL_HEIGHT;

// ─── Public API ────────────────────────────────────────────────
export function totalFrames(episode: Episode): number {
  if (!episode.raceResult) return COUNTDOWN_FRAMES + PODIUM_FRAMES;
  return (
    COUNTDOWN_FRAMES +
    episode.raceResult.raceFrames +
    POST_FINISH_HOLD_FRAMES +
    PODIUM_FRAMES
  );
}

export const RaceSlidesComposition: React.FC<{ episode: Episode }> = ({
  episode,
}) => {
  const { durationInFrames } = useVideoConfig();
  const baseVolume = episode.audioVolume ?? 0.35;
  const fadeVolume = (f: number) => {
    const fadeIn = Math.min(1, f / AUDIO_FADE_FRAMES);
    const fadeOut = Math.min(1, (durationInFrames - f) / AUDIO_FADE_FRAMES);
    return baseVolume * Math.max(0, Math.min(fadeIn, fadeOut));
  };
  return (
    <AbsoluteFill style={{ background: COLOR_BG, fontFamily: INTER }}>
      <Suspense fallback={<AbsoluteFill style={{ background: COLOR_BG }} />}>
        <ThreeCanvas width={1920} height={1080}>
          <Scene episode={episode} />
        </ThreeCanvas>
      </Suspense>
      <HUD episode={episode} />
      {episode.audioPath && (
        <Audio src={staticFile(episode.audioPath)} volume={fadeVolume} loop />
      )}
    </AbsoluteFill>
  );
};

// ─── Bake loader. We delay the entire render via delayRender until the
// binary is fetched, then cache it module-scope so all subsequent frames
// see it immediately. Prior attempts via React Suspense from inside
// ThreeCanvas resulted in a stuck-in-fallback frame — R3F maintains its
// own Suspense boundary that swallowed our throw. Plain delayRender +
// module cache is the simplest pattern that survives Remotion's per-
// frame mount/unmount in headless rendering.
const bakeCache = new Map<string, Float32Array>();
const bakeLoaders = new Map<string, Promise<Float32Array>>();

function loadBake(path: string): Float32Array | null {
  const cached = bakeCache.get(path);
  if (cached) return cached;
  if (!bakeLoaders.has(path)) {
    const handle = delayRender(`race-bake:${path}`);
    const promise = fetch(staticFile(path))
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const arr = new Float32Array(buf);
        bakeCache.set(path, arr);
        continueRender(handle);
        return arr;
      })
      .catch((err) => {
        console.error("Race bake fetch failed", err);
        continueRender(handle);
        throw err;
      });
    bakeLoaders.set(path, promise);
  }
  return null;
}


// ─── Three.js scene ────────────────────────────────────────────
const Scene: React.FC<{ episode: Episode }> = ({ episode }) => {
  const frame = useCurrentFrame();
  // loadBake returns null on the first call (kicking off a delayRender'd
  // fetch); the second pass — after the fetch completes and Remotion
  // re-runs the frame — returns the cached Float32Array. The fallback
  // grid in <Ball/> renders the meantime, but with delayRender holding
  // the capture, the user never sees that frame.
  const bake = episode.raceBakePath ? loadBake(episode.raceBakePath) : null;
  const N = episode.items.length;
  const result = episode.raceResult;

  const pegs = useMemo(
    () => computePegs(episode.raceSeed ?? 0),
    [episode.raceSeed],
  );

  // Translate the absolute Remotion frame into a position into the bake.
  // Before the race starts we read frame 0 (grid). After the race ends we
  // freeze on the last frame (collected at the finish line).
  const raceFrame = result
    ? Math.max(
        0,
        Math.min(
          result.raceFrames - 1,
          frame - COUNTDOWN_FRAMES,
        ),
      )
    : 0;

  return (
    <>
      <color attach="background" args={[COLOR_BG]} />
      <ArenaLights />

      <CameraRig episode={episode} bake={bake} numBalls={N} />

      <Track pegs={pegs} />

      <BallField
        episode={episode}
        bake={bake}
        frame={raceFrame}
        N={N}
      />
    </>
  );
};

// Loads all cover textures in one drei batch. Suspends until every cover
// is ready — caught by the <Suspense> at the AbsoluteFill level, which is
// where Remotion observes Suspense and pauses frame capture. (Putting the
// Suspense inside ThreeCanvas left Remotion seeing a "resolved" tree and
// capturing the fallback render with untextured balls.)
const BallField: React.FC<{
  episode: Episode;
  bake: Float32Array | null;
  frame: number;
  N: number;
}> = ({ episode, bake, frame, N }) => {
  const coverPaths = useMemo(
    () =>
      episode.items.map((it) =>
        it.imagePath ? staticFile(it.imagePath) : staticFile("bg-0.jpeg"),
      ),
    [episode.items],
  );
  const coverTextures = useTexture(coverPaths);
  useMemo(() => {
    const list = Array.isArray(coverTextures) ? coverTextures : [coverTextures];
    for (const t of list) {
      if (t) {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
      }
    }
  }, [coverTextures]);

  return (
    <>
      {Array.from({ length: N }).map((_, i) => (
        <Ball
          key={i}
          index={i}
          color={BALL_PALETTE[i % BALL_PALETTE.length]}
          texture={
            episode.items[i].imagePath
              ? (Array.isArray(coverTextures)
                  ? coverTextures[i]
                  : coverTextures) ?? null
              : null
          }
          bake={bake}
          frame={frame}
          numBalls={N}
        />
      ))}
    </>
  );
};

const ArenaLights: React.FC = () => {
  // Soft, even, "overcast" arena lighting. The hemisphere light gives the
  // floor and the underside of the balls a subtle blue-grey ambient (so
  // they don't go pitch-black on bottom); the key directional adds a single
  // gentle highlight from camera-left, kept low intensity so nothing in the
  // shot has a hard-edged shadow.
  return (
    <>
      <hemisphereLight args={["#f4f7f8", "#8aa1a6", 1.05]} />
      <directionalLight position={[40, 50, 20]} intensity={0.55} />
      <directionalLight position={[-25, 30, -15]} intensity={0.22} />
    </>
  );
};

const Track: React.FC<{ pegs: Array<[number, number]> }> = ({ pegs }) => {
  // Pre-compute railing post X positions. Posts are dense enough that the
  // gap between them is smaller than a ball diameter, so visually the
  // railing reads as "solid wall of bars" rather than "gappy fence."
  const postXs = useMemo(() => {
    const out: number[] = [];
    for (let x = 0; x <= TRACK_LEN; x += RAIL_POST_SPACING) out.push(x);
    return out;
  }, []);

  return (
    <>
      {/* Outer apron — a very wide plane underneath the rails, painted a
          slightly darker shade than the lane. This grounds the track in
          a "floor of the arena" rather than letting it float in space. */}
      <mesh
        position={[TRACK_LEN / 2, FLOOR_Y - 0.55, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <planeGeometry args={[TRACK_LEN * 2.5, TRACK_HALF_Z * 12]} />
        <meshStandardMaterial
          color={COLOR_FLOOR_OUTSIDE}
          roughness={0.95}
          metalness={0.0}
        />
      </mesh>

      {/* Floor — bright off-white with low roughness for soft reflections. */}
      <mesh position={[TRACK_LEN / 2, FLOOR_Y - 0.5, 0]}>
        <boxGeometry args={[TRACK_LEN, 1, TRACK_HALF_Z * 2]} />
        <meshStandardMaterial color={COLOR_FLOOR} roughness={0.45} metalness={0.05} />
      </mesh>

      {/* Vertical-bar railings on both sides. Each side has N posts + a
          continuous top rail running their full length. */}
      {[-1, 1].map((sign) => (
        <group key={sign}>
          {postXs.map((x) => (
            <mesh
              key={x}
              position={[
                x,
                FLOOR_Y + RAIL_TOP_HEIGHT / 2,
                sign * (TRACK_HALF_Z + RAIL_POST_R),
              ]}
            >
              <cylinderGeometry
                args={[RAIL_POST_R, RAIL_POST_R, RAIL_TOP_HEIGHT, 12]}
              />
              <meshStandardMaterial
                color={COLOR_RAIL}
                roughness={0.35}
                metalness={0.55}
              />
            </mesh>
          ))}
          {/* Top rail cap. Sits flush with the top of the posts, slightly
              wider than them so it visually "caps" the row. */}
          <mesh
            position={[
              TRACK_LEN / 2,
              FLOOR_Y + RAIL_TOP_HEIGHT + RAIL_TOP_THICKNESS / 2,
              sign * (TRACK_HALF_Z + RAIL_POST_R),
            ]}
          >
            <boxGeometry
              args={[TRACK_LEN, RAIL_TOP_THICKNESS, RAIL_TOP_THICKNESS * 1.5]}
            />
            <meshStandardMaterial
              color={COLOR_RAIL_TOP}
              roughness={0.4}
              metalness={0.35}
            />
          </mesh>
        </group>
      ))}

      {/* Back wall (start gate). Solid panel — no rails — so the eye
          reads "this is where the race starts." */}
      <mesh position={[-1, FLOOR_Y + WALL_HEIGHT / 2, 0]}>
        <boxGeometry args={[1.2, WALL_HEIGHT + 0.3, TRACK_HALF_Z * 2 + 1]} />
        <meshStandardMaterial color={COLOR_BACK_WALL} roughness={0.55} />
      </mesh>

      {/* Front wall (finish backstop). Same material as the back wall so
          the two ends of the track read as bookends. */}
      <mesh position={[TRACK_LEN + 0.5, FLOOR_Y + WALL_HEIGHT / 2, 0]}>
        <boxGeometry args={[1.2, WALL_HEIGHT + 0.3, TRACK_HALF_Z * 2 + 1]} />
        <meshStandardMaterial color={COLOR_BACK_WALL} roughness={0.55} />
      </mesh>

      {/* Finish-line stripe — thin painted line, not a glowing strip. */}
      <mesh position={[FINISH_X, FLOOR_Y + 0.03, 0]}>
        <boxGeometry args={[0.35, 0.04, TRACK_HALF_Z * 2]} />
        <meshStandardMaterial color="#222" roughness={0.7} />
      </mesh>

      {/* Pegs — muted matte cylinders that read as obstacles, not
          decorations. */}
      {pegs.map(([x, z], i) => (
        <mesh key={i} position={[x, FLOOR_Y + PEG_H / 2, z]}>
          <cylinderGeometry args={[PEG_R, PEG_R, PEG_H, 16]} />
          <meshStandardMaterial color={COLOR_PEG} roughness={0.6} metalness={0.1} />
        </mesh>
      ))}
    </>
  );
};

const Ball: React.FC<{
  index: number;
  color: string;
  texture: THREE.Texture | null;
  bake: Float32Array | null;
  frame: number;
  numBalls: number;
}> = ({ index, color, texture, bake, frame, numBalls }) => {
  // Pull this frame's transform from the bake. Layout: [frame][ball][xyz qx qy qz qw]
  let x = 2,
    y = BALL_R + 0.5,
    z = 0;
  let qx = 0,
    qy = 0,
    qz = 0,
    qw = 1;
  if (bake) {
    const off = (frame * numBalls + index) * 7;
    x = bake[off + 0];
    y = bake[off + 1];
    z = bake[off + 2];
    qx = bake[off + 3];
    qy = bake[off + 4];
    qz = bake[off + 5];
    qw = bake[off + 6];
  } else {
    // Pre-load fallback: best-guess grid position so the scene composes
    // without a flash of stacked-at-origin balls during the first frame.
    const row = Math.floor(index / 5);
    const col = index % 5;
    x = 2 + row * 2.2;
    z = -10 + col * 5;
    y = BALL_R + 0.5 + row * 0.1;
  }

  const quaternion = useMemo(
    () => new THREE.Quaternion(qx, qy, qz, qw),
    [qx, qy, qz, qw],
  );

  return (
    <group position={[x, y, z]} quaternion={quaternion}>
      <mesh>
        <sphereGeometry args={[BALL_R, 48, 32]} />
        {texture ? (
          // Glossier, more "vinyl-painted" material so the cover read
          // stays strong against the bright lane. Roughness 0.18 picks
          // up a visible highlight from the key light; a touch of
          // metalness gives the surface a polished, premium feel
          // without going chrome.
          <meshStandardMaterial
            map={texture}
            roughness={0.18}
            metalness={0.18}
          />
        ) : (
          <meshStandardMaterial
            color={color}
            roughness={0.2}
            metalness={0.2}
          />
        )}
      </mesh>
    </group>
  );
};

// ─── Camera ────────────────────────────────────────────────────
// Three phases, no hard cuts in v1 (cuts come later via cross-faded
// overlay frames). The camera linearly interpolates between an aerial
// grid view and a side-tracking shot, then settles into a podium hold
// after the race finishes.
const CameraRig: React.FC<{
  episode: Episode;
  bake: Float32Array | null;
  numBalls: number;
}> = ({ episode, bake, numBalls }) => {
  const frame = useCurrentFrame();
  const { camera } = useThree();
  const result = episode.raceResult;
  const raceFrames = result?.raceFrames ?? 0;
  const finishFrames = result?.finishFrames ?? [];
  const winnerFinishFrame =
    finishFrames.length > 0 ? finishFrames[0] : raceFrames;

  const raceFrame = Math.max(
    0,
    Math.min(raceFrames > 0 ? raceFrames - 1 : 0, frame - COUNTDOWN_FRAMES),
  );

  // Sample the actual field every frame. We want the camera to follow the
  // BACK of the pack ("trailX") so the entire field is always ahead of the
  // lens. Reference video sets the camera behind everyone, low to the
  // ground, looking forward as balls roll away — that's what reads as a
  // chase cam. meanLeadX is kept for the photo-finish framing.
  const trailX = bake
    ? trailingX(bake, raceFrame, numBalls)
    : 2;
  const leaderX = bake
    ? meanLeadX(bake, raceFrame, numBalls, 3)
    : 4 + (raceFrames > 0 ? raceFrame / raceFrames : 0) * (FINISH_X - 4);

  // Phase weights (0..1).
  const inCountdown = frame < COUNTDOWN_FRAMES;
  const postFinish = result && raceFrame >= winnerFinishFrame;
  const podiumPhase =
    result && raceFrame >= winnerFinishFrame + POST_FINISH_HOLD_FRAMES;

  // ─── Camera waypoints ───
  // GRID: low oblique view of the starting grid, slightly above ball
  // height, sweeping in from the side. Matches the reference's "we see the
  // race as a participant, not from above" framing.
  const grid = {
    pos: [-2, 5, 14] as [number, number, number],
    look: [10, 1, 0] as [number, number, number],
  };
  // CHASE: low chase cam from BEHIND the trailing ball, on the centerline,
  // looking forward down the lane. Mid-distance look-at (between trail and
  // leader) keeps the bulk of the field in the middle third of the frame.
  //
  // Camera x is clamped to a minimum of 2 so it never sits inside (or
  // behind) the start wall at x=-1; at race start the trailing ball is
  // around x=2 and a literal "trail - 8" would put the lens INSIDE the
  // back gate, filling the frame with dark teal.
  const chaseX = Math.max(2, trailX - 9);
  const chase = {
    pos: [chaseX, 3.2, 0] as [number, number, number],
    look: [
      Math.min(FINISH_X - 6, Math.max(chaseX + 10, (trailX + leaderX) / 2 + 4)),
      1.0,
      0,
    ] as [number, number, number],
  };
  // FINISH: hold the chase camera but lower it and look at the line.
  const finish = {
    pos: [FINISH_X - 14, 2.6, 0] as [number, number, number],
    look: [FINISH_X - 2, 0.9, 0] as [number, number, number],
  };
  // PODIUM: elevated past-the-finish-line camera. Y is set high enough to
  // clear the front backstop wall (WALL_HEIGHT + 0.3), so the lens has a
  // clean line of sight back into the lane where finished balls collect.
  // Looking down at slight angle gives the cluster of winners a hero
  // composition without revealing the empty back half of the track.
  const podium = {
    pos: [FINISH_X + 4, 7.5, 5] as [number, number, number],
    look: [FINISH_X - 6, 0.8, 0] as [number, number, number],
  };

  let pos: [number, number, number];
  let look: [number, number, number];
  if (inCountdown) {
    // Slow drift on the grid: gentle x slide so the static phase has motion.
    const t = Easing.inOut(Easing.ease)(frame / COUNTDOWN_FRAMES);
    pos = [
      lerp(grid.pos[0], grid.pos[0] + 3, t),
      grid.pos[1],
      lerp(grid.pos[2], grid.pos[2] - 2, t),
    ];
    look = grid.look;
  } else if (podiumPhase) {
    pos = podium.pos;
    look = podium.look;
  } else if (postFinish) {
    // 2s zoom from chase into the finish frame.
    const t = Easing.inOut(Easing.ease)(
      (raceFrame - winnerFinishFrame) / POST_FINISH_HOLD_FRAMES,
    );
    pos = lerp3(chase.pos, finish.pos, t);
    look = lerp3(chase.look, finish.look, t);
  } else {
    // Race body: blend out of grid into chase over the first ~1s, then
    // pure chase for the rest of the race.
    const blendFrames = 60;
    const t = Math.min(1, (frame - COUNTDOWN_FRAMES) / blendFrames);
    const ease = Easing.inOut(Easing.ease)(t);
    pos = lerp3(grid.pos, chase.pos, ease);
    look = lerp3(grid.look, chase.look, ease);
  }

  camera.position.set(pos[0], pos[1], pos[2]);
  camera.lookAt(look[0], look[1], look[2]);
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.fov = 48;
    camera.updateProjectionMatrix();
  }
  return null;
};

// ─── HUD overlay ───────────────────────────────────────────────
const HUD: React.FC<{ episode: Episode }> = ({ episode }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const result = episode.raceResult;

  // Countdown digit logic. We show "3" for the first second, "2" for the
  // second, "1" for the third, and "GO!" at the moment of launch.
  const countdownActive = frame < COUNTDOWN_FRAMES;
  const secondsLeft = Math.ceil((COUNTDOWN_FRAMES - frame) / fps);
  const goLabel = frame < COUNTDOWN_FRAMES - fps * 0.2 ? `${secondsLeft}` : "GO!";

  // Winner banner — pops in 0.8s after #1 crosses.
  const raceFrame = Math.max(0, frame - COUNTDOWN_FRAMES);
  const winnerIndex = result?.finishOrder[0];
  const winnerFinishFrame = result?.finishFrames?.[0] ?? Number.MAX_SAFE_INTEGER;
  const winnerVisible =
    result != null &&
    winnerIndex != null &&
    raceFrame >= winnerFinishFrame + fps * 0.5;

  const winnerOpacity = winnerVisible
    ? Math.min(1, (raceFrame - winnerFinishFrame - fps * 0.5) / (fps * 0.5))
    : 0;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {/* Title bar — episode title across the top during countdown. */}
      {countdownActive && (
        <div
          style={{
            position: "absolute",
            top: 64,
            left: 0,
            right: 0,
            textAlign: "center",
            color: "#ffffff",
            textShadow: "0 4px 24px rgba(0,0,0,0.85)",
            opacity: interpolate(frame, [0, 20], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          <div
            style={{
              fontSize: 36,
              letterSpacing: 6,
              opacity: 0.7,
              textTransform: "uppercase",
              fontWeight: 600,
            }}
          >
            {episode.title[0]}
          </div>
          <div
            style={{
              fontSize: 72,
              fontWeight: 900,
              letterSpacing: 2,
            }}
          >
            {episode.title[1]}
          </div>
        </div>
      )}

      {/* Countdown digit. */}
      {countdownActive && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: 0,
            right: 0,
            transform: "translateY(-50%)",
            textAlign: "center",
            color: "#f5b35a",
            fontSize: 320,
            fontWeight: 900,
            letterSpacing: -8,
            textShadow: "0 8px 48px rgba(0,0,0,0.9)",
            opacity: countdownPulseOpacity(frame, fps),
          }}
        >
          {goLabel}
        </div>
      )}

      {/* Winner banner after #1 crosses. */}
      {winnerOpacity > 0 && winnerIndex != null && (
        <div
          style={{
            position: "absolute",
            top: 80,
            left: 0,
            right: 0,
            textAlign: "center",
            color: "#ffffff",
            opacity: winnerOpacity,
            textShadow: "0 6px 32px rgba(0,0,0,0.95)",
          }}
        >
          <div
            style={{
              fontSize: 32,
              letterSpacing: 8,
              opacity: 0.7,
              textTransform: "uppercase",
              fontWeight: 600,
            }}
          >
            Winner
          </div>
          <div
            style={{
              fontSize: 96,
              fontWeight: 900,
              color: "#f5b35a",
              marginTop: 8,
            }}
          >
            {episode.items[winnerIndex].title}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};

// ─── Helpers ───────────────────────────────────────────────────
function computePegs(seed: number): Array<[number, number]> {
  const rand = mulberry32(seed);
  // The order of rand() calls MUST exactly match scripts/race-roll.mjs's
  // buildTrack so peg positions visually align with their physics counter-
  // parts. Specifically: the simulator consumes zJitter and then per-cell
  // (skip-roll, x-jitter) for every cell in the row, and only places a peg
  // if skip-roll <= 0.6.
  const out: Array<[number, number]> = [];
  const numRows = Math.floor((PEG_X_MAX - PEG_X_MIN) / PEG_ROW_DX);
  for (let row = 0; row < numRows; row++) {
    const x = PEG_X_MIN + row * PEG_ROW_DX;
    const offset = row % 2 === 0 ? 0 : PEG_ROW_DZ / 2;
    const zJitter = (rand() - 0.5) * 1.5;
    for (let z = -TRACK_HALF_Z + 3; z <= TRACK_HALF_Z - 3; z += PEG_ROW_DZ) {
      const skip = rand();
      const xJitter = (rand() - 0.5) * 1.2;
      if (skip > 0.6) continue;
      out.push([x + xJitter, z + offset + zJitter]);
    }
  }
  return out;
}

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function meanLeadX(
  bake: Float32Array,
  frame: number,
  N: number,
  k: number,
): number {
  // Pluck this frame's x-positions and average the top k. Reading directly
  // from the typed array avoids allocating an Array() every frame.
  const xs = new Array<number>(N);
  const base = frame * N * 7;
  for (let i = 0; i < N; i++) xs[i] = bake[base + i * 7];
  xs.sort((a, b) => b - a);
  let sum = 0;
  const cap = Math.min(k, N);
  for (let i = 0; i < cap; i++) sum += xs[i];
  return sum / cap;
}

function trailingX(bake: Float32Array, frame: number, N: number): number {
  // Smallest x among balls that are still on the track (y > -1 filters out
  // eliminations parked far below). Falls back to start of track if every
  // remaining ball has been eliminated.
  let min = Infinity;
  const base = frame * N * 7;
  for (let i = 0; i < N; i++) {
    const x = bake[base + i * 7];
    const y = bake[base + i * 7 + 1];
    if (y > -1 && x < min) min = x;
  }
  return Number.isFinite(min) ? min : 0;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function countdownPulseOpacity(frame: number, fps: number): number {
  const phaseFrame = frame % fps;
  // Punch in for the first 200ms of each second, hold, then fade out the
  // last 200ms so the digit has a heartbeat.
  if (phaseFrame < fps * 0.2)
    return interpolate(phaseFrame, [0, fps * 0.2], [0, 1]);
  if (phaseFrame > fps * 0.8)
    return interpolate(phaseFrame, [fps * 0.8, fps], [1, 0]);
  return 1;
}
