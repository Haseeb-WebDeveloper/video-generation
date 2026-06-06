// Computes WHEN each narration clip should start, per template, so the
// generated voiceover lines up with the camera as it reveals each item.
//
// The two templates reveal items in the SAME logical order (#1 last — the
// payoff) but with DIFFERENT pacing, so each clip carries a cue time for each:
//   { id, kind, rank?, flowSec, barsSec }
// Each template reads its own field from the manifest at runtime.
//
// These constants MIRROR the .tsx files. If you change pacing there, change it
// here too (no shared import: the .tsx live in the Remotion bundle, this is a
// plain Node script).

export const FPS = 60;

// ── flow-slides.tsx ──
// swoop onto title (PHASE_INTRO) → title hold (TITLE_HOLD) → PER_ITEM per card,
// counting DOWN by rank (rank N first … #1 last) → TAIL_PADDING outro hold.
export const FLOW = {
  PHASE_INTRO: 130,
  TITLE_HOLD: 110,
  PER_ITEM_FRAMES: 300,
  TAIL_PADDING: 360,
};

// ── bar-slides.tsx ──
// dive onto the FIRST (smallest-value) bar over INTRO_FRAMES, then constant-
// velocity pan: each next bar arrives every PER_ITEM_FRAMES. Bars are sorted
// ascending by value, so the largest (= rank #1) is the last bar reached at
// INTRO_FRAMES + (N-1)*PER_ITEM_FRAMES. Then EXIT + HOLD_OUTRO.
export const BARS = {
  INTRO_FRAMES: 130,
  PER_ITEM_FRAMES: 195,
  EXIT_FRAMES: 140,
  HOLD_OUTRO: 320,
};

// Returns the clip schedule: an ordered list (reveal order, #1 last) of
// { id, kind, rank?, title?, value?, flowSec, barsSec }.
//   - hook  : cold-open line during the intro
//   - item  : one per ranked item
//   - outro : closing line during the outro hold
export function buildSchedule(episode) {
  // Reveal order = descending rank (#1 last) — both templates agree.
  const items = [...episode.items].sort(
    (a, b) => (b.rank ?? 0) - (a.rank ?? 0),
  );
  const N = items.length;

  const flowTravelStart = FLOW.PHASE_INTRO + FLOW.TITLE_HOLD;

  const schedule = [];

  // Hook: small lead-in, inside both intro windows
  // (flow: 240f / 4s; bars: 130f / ~2.2s). 24f = 0.4s is safe for both.
  schedule.push({ id: "hook", kind: "hook", flowSec: 24 / FPS, barsSec: 18 / FPS });

  items.forEach((it, i) => {
    // flow: line starts a beat into this card's ~5s window.
    const flowFrame = flowTravelStart + i * FLOW.PER_ITEM_FRAMES + 20;
    // bars: bar i arrives at INTRO + i*PER_ITEM; start a small beat after so
    // the bar+number are on screen before the line lands.
    const barsFrame = BARS.INTRO_FRAMES + i * BARS.PER_ITEM_FRAMES + 18;
    schedule.push({
      id: String(it.rank ?? i + 1),
      kind: "item",
      rank: it.rank ?? i + 1,
      title: it.title,
      value: it.value,
      flowSec: flowFrame / FPS,
      barsSec: barsFrame / FPS,
    });
  });

  // Outro: a beat after the last (#1) reveal line, so the dramatic #1 line
  // finishes before the CTA. flow last card closes at travelStart+N*PER_ITEM;
  // bars last bar is reached at INTRO+(N-1)*PER_ITEM, then EXIT begins.
  const flowOutro = flowTravelStart + N * FLOW.PER_ITEM_FRAMES + 90;
  const barsOutro =
    BARS.INTRO_FRAMES + (N - 1) * BARS.PER_ITEM_FRAMES + BARS.EXIT_FRAMES + 60;
  schedule.push({ id: "outro", kind: "outro", flowSec: flowOutro / FPS, barsSec: barsOutro / FPS });

  return schedule;
}

// Total composition length in seconds for each template (mirrors each
// template's totalFrames for a no-intro episode).
export function totalSeconds(episode) {
  const N = episode.items.length;
  return {
    flow:
      (FLOW.PHASE_INTRO + FLOW.TITLE_HOLD + N * FLOW.PER_ITEM_FRAMES + FLOW.TAIL_PADDING) /
      FPS,
    bars:
      (BARS.INTRO_FRAMES + Math.max(0, N - 1) * BARS.PER_ITEM_FRAMES + BARS.EXIT_FRAMES + BARS.HOLD_OUTRO) /
      FPS,
  };
}
