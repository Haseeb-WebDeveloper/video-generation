// Voiceover timing + live preview playback, shared by flow-slides and bar-slides.
//
// The narration manifest (public/voiceover/<slug>/manifest.json, written by
// scripts/generate-voiceover.mjs) is the SINGLE SOURCE OF TRUTH for timing.
// Clips are laid out sequentially (no overlap, even gaps) from the real audio
// durations, so the commentary sounds like one continuous voice. The templates
// read it two ways:
//   1. calculateMetadata (in Root.tsx) calls loadVoiceoverManifest() to set the
//      video length and the per-item reveal cue frames from the audio.
//   2. the component renders <VoiceoverAudio> to play the clips in the preview.
//
// The headless render is --muted and re-muxes audio via ffmpeg using the same
// manifest, so narration is never double-applied at render.

import {
  Audio,
  Sequence,
  staticFile,
} from "remotion";

export type VoiceoverClip = {
  id: string;
  kind: "hook" | "item" | "outro";
  startSec: number;
  durationSec: number;
  file: string;
  text?: string;
};

export type VoiceoverManifest = {
  slug: string;
  fps: number;
  totalAudioSec: number;
  leadInSec: number;
  clips: VoiceoverClip[];
};

// Per-episode props the templates use to drive camera + duration from audio.
export type VoiceoverTiming = {
  durationInFrames: number;
  // Frame at which each reveal-order item's LINE STARTS (reveal order =
  // #N first … #1 last). Indexed 0..N-1.
  itemCueFrames: number[];
  // Frame at which each item's line ENDS (start + audio duration). Same index.
  // The camera moves slowly during [cue, end] (line playing) and faster in the
  // gap [end, nextCue] so motion is continuous but the spoken card owns centre.
  itemEndFrames: number[];
  // Frame the outro line starts (camera pans to the outro board here).
  outroCueFrame: number;
  // Frame the first item is revealed (intro/title hold ends here).
  firstItemFrame: number;
  clips: VoiceoverClip[];
};

// Async manifest fetch, usable in Remotion's async calculateMetadata.
// Returns null when no voiceover has been generated for this episode.
export async function loadVoiceoverManifest(
  slug: string,
): Promise<VoiceoverManifest | null> {
  try {
    const res = await fetch(staticFile(`voiceover/${slug}/manifest.json`));
    if (!res.ok) return null;
    const m = (await res.json()) as VoiceoverManifest;
    if (!m?.clips?.length) return null;
    // Reject old-format manifests (pre audio-driven timing) that lack the
    // per-clip durationSec — they'd produce NaN durations. Regenerate with
    // `npm run voiceover <slug> --force` to upgrade them.
    const valid = m.clips.every(
      (c) => Number.isFinite(c.startSec) && Number.isFinite(c.durationSec),
    );
    if (!valid) return null;
    return m;
  } catch {
    return null;
  }
}

// Turn a manifest into camera/duration timing for `fps`. `tailSec` is extra
// hold after the last word so the video doesn't cut on the final syllable.
export function timingFromManifest(
  m: VoiceoverManifest,
  fps: number,
  tailSec = 1.2,
): VoiceoverTiming {
  const items = m.clips.filter((c) => c.kind === "item");
  const outro = m.clips.find((c) => c.kind === "outro");
  const itemCueFrames = items.map((c) => Math.round(c.startSec * fps));
  const itemEndFrames = items.map((c) =>
    Math.round((c.startSec + c.durationSec) * fps),
  );
  const lastEnd = m.clips.reduce(
    (max, c) => Math.max(max, c.startSec + c.durationSec),
    0,
  );
  return {
    durationInFrames: Math.ceil((lastEnd + tailSec) * fps),
    itemCueFrames,
    itemEndFrames,
    outroCueFrame: Math.round((outro?.startSec ?? lastEnd) * fps),
    firstItemFrame: itemCueFrames[0] ?? 0,
    clips: m.clips,
  };
}

// Plays each clip at its cue frame in the Studio preview.
export const VoiceoverAudio: React.FC<{ clips: VoiceoverClip[]; fps: number }> = ({
  clips,
  fps,
}) => (
  <>
    {clips.map((c) => (
      <Sequence key={c.id} from={Math.round(c.startSec * fps)} name={`vo-${c.id}`}>
        <Audio src={staticFile(c.file)} />
      </Sequence>
    ))}
  </>
);
