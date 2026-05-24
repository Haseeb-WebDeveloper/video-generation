import {
  AbsoluteFill,
  Audio,
  Img,
  Series,
  Easing,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
import type { Episode, EpisodeItem, TournamentRound } from "./episode";
import {
  TopBattleSlidesComposition,
  totalFrames as battleTotalFrames,
} from "./top-battle-slides";

const { fontFamily: INTER } = loadFont();

const COLOR_BG = "#ece3fb";
const ACCENT = "#963d5a"; // rose accent — premium + high-contrast on the light cards

// Render text in normal Title Case regardless of how it's stored (episode
// titles/labels are kept uppercase in the data) — the user prefers not-uppercase.
const titleCase = (s: string) =>
  s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// Segment durations @ 30fps. Cards held long enough to comfortably read every
// country before the battle starts.
const FPS = 30;
const INTRO_FRAMES = 5 * FPS;
const ROUND_CARD_FRAMES = 5.5 * FPS;
const FINALISTS_CARD_FRAMES = 6 * FPS;
const CHAMPION_FRAMES = 6 * FPS;

// ─── A round rendered as a self-contained "battle episode" ─────────
function roundEpisode(episode: Episode, round: TournamentRound): Episode {
  return {
    ...episode,
    items: round.itemIndices.map((i) => episode.items[i]),
    battleBakePath: round.bakePath,
    battleResult: {
      survivorOrder: round.survivorOrder,
      eliminationFrames: round.eliminationFrames,
      eliminationReasons: [],
      battleFrames: round.battleFrames,
    },
  };
}

export function tournamentTotalFrames(episode: Episode): number {
  const tr = episode.tournamentResult;
  if (!tr) return INTRO_FRAMES + CHAMPION_FRAMES;
  let total = INTRO_FRAMES;
  for (const r of tr.rounds) {
    total += r.kind === "final" ? FINALISTS_CARD_FRAMES : ROUND_CARD_FRAMES;
    total += battleTotalFrames(roundEpisode(episode, r));
  }
  total += CHAMPION_FRAMES;
  return total;
}

// ─── Composition ───────────────────────────────────────────────────
export const TournamentComposition: React.FC<{ episode: Episode }> = ({
  episode,
}) => {
  const tr = episode.tournamentResult;
  const { durationInFrames } = useVideoConfig();
  if (!tr) {
    return <AbsoluteFill style={{ background: COLOR_BG }} />;
  }

  const champion = episode.items[tr.championIndex];
  const finalRound = tr.rounds.find((r) => r.kind === "final");
  const finalists = finalRound
    ? finalRound.itemIndices.map((i) => episode.items[i])
    : [];

  const segments: React.ReactNode[] = [];
  segments.push(
    <Series.Sequence key="intro" durationInFrames={INTRO_FRAMES}>
      <IntroCard episode={episode} />
    </Series.Sequence>,
  );
  tr.rounds.forEach((r, idx) => {
    const isFinal = r.kind === "final";
    segments.push(
      <Series.Sequence
        key={`card-${idx}`}
        durationInFrames={isFinal ? FINALISTS_CARD_FRAMES : ROUND_CARD_FRAMES}
      >
        {isFinal ? (
          <FinalistsCard finalists={finalists} />
        ) : (
          <RoundCard
            label={r.label}
            roundNum={idx + 1}
            totalRounds={tr.rounds.length - 1}
            items={r.itemIndices.map((i) => episode.items[i])}
          />
        )}
      </Series.Sequence>,
    );
    segments.push(
      <Series.Sequence
        key={`battle-${idx}`}
        durationInFrames={battleTotalFrames(roundEpisode(episode, r))}
      >
        <TopBattleSlidesComposition
          episode={roundEpisode(episode, r)}
          hideAudio
          collisions={r.collisions}
        />
      </Series.Sequence>,
    );
  });
  segments.push(
    <Series.Sequence key="champion" durationInFrames={CHAMPION_FRAMES}>
      <ChampionCard champion={champion} />
    </Series.Sequence>,
  );

  const baseVolume = episode.audioVolume ?? 0.3;
  const fadeVolume = (f: number) => {
    const fadeIn = Math.min(1, f / 60);
    const fadeOut = Math.min(1, (durationInFrames - f) / 90);
    return baseVolume * Math.max(0, Math.min(fadeIn, fadeOut));
  };

  return (
    <AbsoluteFill style={{ background: COLOR_BG, fontFamily: INTER }}>
      <Series>{segments}</Series>
      {episode.audioPath && (
        <Audio src={staticFile(episode.audioPath)} volume={fadeVolume} loop />
      )}
    </AbsoluteFill>
  );
};

// ─── Cards ─────────────────────────────────────────────────────────
// Cards share the playground's 3D studio look: a perspective GRID FLOOR
// receding into a soft lavender cove, with the content sitting in that 3D space.
const CardShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      fontFamily: INTER,
      color: "#2c2333",
      overflow: "hidden",
      // Lavender "cove" (sky) the grid floor fades up into.
      background: "linear-gradient(180deg, #d3c7ea 0%, #e7ddf7 48%, #efe8fb 100%)",
      perspective: "600px",
      perspectiveOrigin: "50% 34%",
    }}
  >
    {/* Perspective grid floor — folds down from a horizon line (~46% height) and
        recedes, same axis-aligned reference grid as the arena floor, so the card
        reads as a real 3D scene. Fades into the cove at the horizon. */}
    <div
      style={{
        position: "absolute",
        top: "46%",
        left: "-60%",
        width: "220%",
        height: "78%",
        transformOrigin: "center top",
        transform: "rotateX(66deg)",
        backgroundColor: "#e1d6f2",
        backgroundImage:
          "linear-gradient(0deg, rgba(108,64,104,0.22) 2px, transparent 2px), linear-gradient(90deg, rgba(108,64,104,0.22) 2px, transparent 2px)",
        backgroundSize: "108px 108px",
        WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 34%)",
        maskImage: "linear-gradient(to bottom, transparent 0%, black 34%)",
      }}
    />
    {/* Content sits IN the scene — a subtle 3D tilt so the text/flags read as
        placed in the perspective space, not flat stickers (kept gentle so it
        stays perfectly legible). */}
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        transform: "rotateX(5deg)",
        transformStyle: "preserve-3d",
      }}
    >
      {children}
    </AbsoluteFill>
  </AbsoluteFill>
);

function flagSrc(item: EpisodeItem): string {
  return item.imagePath
    ? staticFile(item.imagePath)
    : staticFile(`flags/${(item.country ?? "us").toLowerCase()}.png`);
}

const FlagChip: React.FC<{ item: EpisodeItem; size: number; delay: number }> = ({
  item,
  size,
  delay,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 14, stiffness: 120 } });
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        transform: `scale(${s})`,
        opacity: s,
      }}
    >
      <Img
        src={flagSrc(item)}
        style={{
          width: size,
          height: size * 0.66,
          objectFit: "cover",
          borderRadius: 8,
          border: "2px solid rgba(60,40,60,0.12)",
          boxShadow: "0 10px 26px rgba(70,40,70,0.18)",
        }}
      />
      <div style={{ fontSize: size * 0.16, fontWeight: 600, opacity: 1 }}>
        {item.title}
      </div>
    </div>
  );
};

// Consistent in-video title across ALL episodes (clarity over per-theme names).
const INTRO_TITLE = "Country Spin Battle";

const IntroCard: React.FC<{ episode: Episode }> = ({ episode }) => {
  const frame = useCurrentFrame();
  // Clean letter-by-letter swing-in: each character rises + swings up (3D
  // rotateX about its base) + fades, staggered left→right on a refined ease-out
  // (no bounce). Then it HOLDS still. Subtitle eases up after the word lands.
  const easeOut = Easing.out(Easing.cubic);
  const STAGGER = 1.8; // frames between letters
  const DUR = 16; // per-letter reveal length
  const letters = INTRO_TITLE.split("");
  const titleDone = (letters.length - 1) * STAGGER + DUR;
  const sp = interpolate(frame, [titleDone - 4, titleDone + 24], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeOut,
  });
  const n = episode.items.length;
  return (
    <CardShell>
      <div style={{ textAlign: "center" }}>
        <div
          style={{
            perspective: 800,
            fontSize: 132,
            fontWeight: 800,
            color: ACCENT,
            letterSpacing: 1,
            lineHeight: 1,
          }}
        >
          {letters.map((ch, i) => {
            const p = interpolate(
              frame,
              [i * STAGGER, i * STAGGER + DUR],
              [0, 1],
              { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut },
            );
            return (
              <span
                key={i}
                style={{
                  display: "inline-block",
                  opacity: p,
                  transformOrigin: "50% 100%",
                  transform: `translateY(${(1 - p) * 0.5}em) rotateX(${(1 - p) * -70}deg)`,
                }}
              >
                {ch === " " ? " " : ch}
              </span>
            );
          })}
        </div>
        <div
          style={{
            fontSize: 56,
            marginTop: 58,
            fontWeight: 500,
            letterSpacing: 0.5,
            opacity: sp * 0.82,
            transform: `translateY(${(1 - sp) * 16}px)`,
          }}
        >
          {n} flags spin · last one standing wins
        </div>
      </div>
    </CardShell>
  );
};

const RoundCard: React.FC<{
  label: string;
  roundNum: number;
  totalRounds: number;
  items: EpisodeItem[];
}> = ({ label, roundNum, totalRounds, items }) => {
  const frame = useCurrentFrame();
  const op = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: "clamp" });
  return (
    <CardShell>
      <div style={{ opacity: op * 0.55, fontSize: 26, letterSpacing: 4, fontWeight: 600 }}>
        Group {roundNum} of {totalRounds}
      </div>
      <div style={{ opacity: op, fontSize: 110, fontWeight: 800, color: ACCENT, letterSpacing: 2, marginBottom: 36 }}>
        {titleCase(label)}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: "28px 44px",
          maxWidth: 1300,
        }}
      >
        {items.map((it, i) => (
          <FlagChip key={i} item={it} size={150} delay={8 + i * 3} />
        ))}
      </div>
    </CardShell>
  );
};

const FinalistsCard: React.FC<{ finalists: EpisodeItem[] }> = ({ finalists }) => {
  const frame = useCurrentFrame();
  const op = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: "clamp" });
  return (
    <CardShell>
      <div style={{ opacity: op * 0.55, fontSize: 30, letterSpacing: 4, fontWeight: 600 }}>
        The
      </div>
      <div style={{ opacity: op, fontSize: 130, fontWeight: 800, color: ACCENT, letterSpacing: 2, marginBottom: 48 }}>
        Finalists
      </div>
      <div style={{ display: "flex", gap: 70 }}>
        {finalists.map((it, i) => (
          <FlagChip key={i} item={it} size={220} delay={10 + i * 8} />
        ))}
      </div>
    </CardShell>
  );
};

const ChampionCard: React.FC<{ champion: EpisodeItem }> = ({ champion }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 12, stiffness: 90 } });
  const glow = 0.5 + 0.5 * Math.sin(frame * 0.12);
  return (
    <CardShell>
      <div style={{ fontSize: 34, letterSpacing: 6, fontWeight: 600, opacity: 0.7 }}>
        🏆 Champion 🏆
      </div>
      <div style={{ transform: `scale(${s})`, marginTop: 30, marginBottom: 24 }}>
        <Img
          src={flagSrc(champion)}
          style={{
            width: 460,
            height: 300,
            objectFit: "cover",
            borderRadius: 18,
            border: `4px solid ${ACCENT}`,
            boxShadow: `0 0 ${40 + glow * 50}px rgba(150,61,90,${0.4 + glow * 0.35})`,
          }}
        />
      </div>
      <div style={{ fontSize: 96, fontWeight: 800, color: ACCENT, letterSpacing: 1 }}>
        {champion.title}
      </div>
    </CardShell>
  );
};
