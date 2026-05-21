import {
  AbsoluteFill,
  Audio,
  Img,
  Series,
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

const COLOR_BG = "#0a0c10";
const GOLD = "#f5b35a";

// Segment durations (frames @ 60fps).
const INTRO_FRAMES = 3.5 * 60;
const ROUND_CARD_FRAMES = 2.5 * 60;
const FINALISTS_CARD_FRAMES = 4 * 60;
const CHAMPION_FRAMES = 5 * 60;

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
        <TopBattleSlidesComposition episode={roundEpisode(episode, r)} hideAudio />
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
const CardShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      fontFamily: INTER,
      color: "#fff",
      background:
        "radial-gradient(ellipse at 50% 40%, #1a1f2a 0%, #0a0c10 70%)",
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "column",
    }}
  >
    {children}
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
          border: "2px solid rgba(255,255,255,0.25)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.55)",
        }}
      />
      <div style={{ fontSize: size * 0.16, fontWeight: 600, opacity: 0.9 }}>
        {item.title}
      </div>
    </div>
  );
};

const IntroCard: React.FC<{ episode: Episode }> = ({ episode }) => {
  const frame = useCurrentFrame();
  const op = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  return (
    <CardShell>
      <div style={{ opacity: op, textAlign: "center" }}>
        <div style={{ fontSize: 40, letterSpacing: 8, fontWeight: 500, opacity: 0.8 }}>
          {episode.title[0]}
        </div>
        <div style={{ fontSize: 130, fontWeight: 800, color: GOLD, letterSpacing: 2, lineHeight: 1 }}>
          {episode.title[1]}
        </div>
        <div style={{ fontSize: 30, marginTop: 24, opacity: 0.7, fontWeight: 500 }}>
          {episode.items.length} nations · {(episode.tournamentResult?.rounds.length ?? 1) - 1} groups · 1 champion
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
      <div style={{ opacity: op * 0.7, fontSize: 26, letterSpacing: 10, fontWeight: 600 }}>
        GROUP {roundNum} OF {totalRounds}
      </div>
      <div style={{ opacity: op, fontSize: 110, fontWeight: 800, color: GOLD, letterSpacing: 2, marginBottom: 36 }}>
        {label}
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
      <div style={{ opacity: op * 0.75, fontSize: 30, letterSpacing: 10, fontWeight: 600 }}>
        THE
      </div>
      <div style={{ opacity: op, fontSize: 130, fontWeight: 800, color: GOLD, letterSpacing: 2, marginBottom: 48 }}>
        FINALISTS
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
      <div style={{ fontSize: 34, letterSpacing: 12, fontWeight: 600, opacity: 0.8 }}>
        🏆 CHAMPION 🏆
      </div>
      <div style={{ transform: `scale(${s})`, marginTop: 30, marginBottom: 24 }}>
        <Img
          src={flagSrc(champion)}
          style={{
            width: 460,
            height: 300,
            objectFit: "cover",
            borderRadius: 18,
            border: `4px solid ${GOLD}`,
            boxShadow: `0 0 ${40 + glow * 50}px rgba(245,179,90,${0.5 + glow * 0.4})`,
          }}
        />
      </div>
      <div style={{ fontSize: 96, fontWeight: 800, color: GOLD, letterSpacing: 1 }}>
        {champion.title}
      </div>
    </CardShell>
  );
};
