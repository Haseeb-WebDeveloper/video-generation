// Compute YouTube chapter timestamps for an episode.
//
// Mirrors the runtime weight math in src/Billboards.tsx so each chapter lands
// at the frame where the camera is centered on the corresponding cover.
// Items are sorted descending by rank (countdown order) — same as buildRuntime.
//
// Constants kept in sync with src/Billboards.tsx pacing block (lines 73-76).

const FPS = 60;
const PHASE_INTRO = 200;
const PER_ITEM_FRAMES = 330;

const TITLE_WEIGHT = 2.6;
const OUTRO_WEIGHT = 2.6;

// ── Tournament chapters ──────────────────────────────────────────
// Keep these in sync with the segment durations in src/tournament-slides.tsx
// and the countdown/podium in src/top-battle-slides.tsx (all @ 30fps).
const T_FPS = 30;
const T_INTRO = 5 * T_FPS;
const T_ROUND_CARD = 5.5 * T_FPS;
const T_FINALISTS_CARD = 6 * T_FPS;
const T_CHAMPION = 6 * T_FPS;
const T_COUNTDOWN = 3 * T_FPS;
const T_PODIUM = 4 * T_FPS;

function tFramesToTime(frame) {
  const sec = Math.round(frame / T_FPS);
  const mm = Math.floor(sec / 60);
  const ss = String(sec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function computeTournamentChapters(episode) {
  const rounds = episode.tournamentResult.rounds;
  // First chapter pinned to 0:00 and labelled "Round 1" (it absorbs the short
  // intro), so every gap clears YouTube's 10s minimum and the chapters render
  // as clickable segments.
  const chapters = [];
  let cursor = T_INTRO;
  let groupNum = 0;
  for (const r of rounds) {
    const isFinal = r.kind === "final";
    const card = isFinal ? T_FINALISTS_CARD : T_ROUND_CARD;
    const label = isFinal ? "Final" : `Round ${++groupNum}`;
    const frame = chapters.length === 0 ? 0 : cursor;
    chapters.push({ frame, time: tFramesToTime(frame), label });
    cursor += card + (T_COUNTDOWN + r.battleFrames + T_PODIUM);
  }
  chapters.push({ frame: cursor, time: tFramesToTime(cursor), label: "Champion" });
  // Guarantee strictly-increasing whole-second times.
  for (let i = 1; i < chapters.length; i++) {
    if (chapters[i].frame <= chapters[i - 1].frame) {
      chapters[i].frame = chapters[i - 1].frame + T_FPS;
      chapters[i].time = tFramesToTime(chapters[i].frame);
    }
  }
  return chapters;
}

export function computeChapters(episode) {
  if (episode.tournamentResult) return computeTournamentChapters(episode);
  // Single battle / race — one continuous event, no meaningful chapters (and a
  // ~25s video can't have clickable chapters anyway). Return none.
  if (episode.battleResult || episode.raceResult) return [];
  const sorted = [...episode.items].sort((a, b) => b.rank - a.rank);
  const N = sorted.length;
  const maxValue = Math.max(...sorted.map((i) => i.value));

  const weights = [
    TITLE_WEIGHT,
    ...sorted.map((it) => 0.85 + Math.sqrt(it.value / maxValue)),
    OUTRO_WEIGHT,
  ];
  const cum = [0];
  for (const w of weights) cum.push(cum.at(-1) + w);
  const total = cum.at(-1);
  const travel = N * PER_ITEM_FRAMES;

  const centerFrame = (k) =>
    Math.round(PHASE_INTRO + (travel * (cum[k] + cum[k + 1])) / 2 / total);

  const chapters = [{ frame: 0, time: "0:00", label: "Intro" }];

  for (let i = 0; i < N; i++) {
    const frame = centerFrame(i + 1);
    chapters.push({
      frame,
      time: framesToTime(frame),
      label: `#${sorted[i].rank} ${sorted[i].title}`,
    });
  }

  const outroFrame = centerFrame(N + 1);
  chapters.push({
    frame: outroFrame,
    time: framesToTime(outroFrame),
    label: "Outro",
  });

  // YouTube requires strictly increasing chapter times. Rounding can produce
  // ties when items are very closely weighted; nudge tied chapters forward
  // by 1 second so the list stays monotonic.
  for (let i = 1; i < chapters.length; i++) {
    const prevSec = Math.floor(chapters[i - 1].frame / FPS);
    const curSec = Math.floor(chapters[i].frame / FPS);
    if (curSec <= prevSec) {
      const newFrame = (prevSec + 1) * FPS;
      chapters[i].frame = newFrame;
      chapters[i].time = framesToTime(newFrame);
    }
  }

  return chapters;
}

// YouTube auto-detects clickable chapters only when each gap is ≥ 10 seconds
// and the list has ≥ 3 entries. With PER_ITEM_FRAMES=330 (5.5s per item) this
// returns false; chapters still appear as text in the description.
export function chaptersWillAutoDetect(chapters) {
  if (chapters.length < 3) return false;
  for (let i = 1; i < chapters.length; i++) {
    const gapSec = (chapters[i].frame - chapters[i - 1].frame) / FPS;
    if (gapSec < 10) return false;
  }
  return true;
}

function framesToTime(frame) {
  const sec = Math.floor(frame / FPS);
  const mm = Math.floor(sec / 60);
  const ss = String(sec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
