#!/usr/bin/env node
// Render one episode to out/<slug>.mp4 via the Remotion CLI.
//
// The composition id IS the slug — Root.tsx registers one Composition per
// episode JSON, keyed by slug. Duration auto-computed via calculateMetadata
// using totalFrames(items), so it matches the studio.
//
// Usage: node scripts/render-episode.mjs <slug>
//
// Audio: when the episode has an audioPath, the Remotion render runs with
// --muted and audio is muxed in afterwards with ffmpeg (stream-copy on the
// video side, so it's near-instant). This dodges a Remotion audio-mixing
// bug that surfaces on long compositions with looped sources — the renderer
// would queue ffmpeg jobs against a temp directory that hadn't been
// created yet, aborting the final mux after hours of frame rendering.
// The <Audio> component in *-slides.tsx is still authoritative for the
// studio preview; only the headless render bypasses it.

import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadEpisode, parseCompositionId } from "./lib/episode-loader.mjs";

const [, , compositionId] = process.argv;
if (!compositionId) {
  console.error(
    "Usage: node scripts/render-episode.mjs <slug>-flow|-bars|-race|-battle",
  );
  process.exit(1);
}

// Composition ids are <slug>-flow, <slug>-bars, <slug>-race, or
// <slug>-battle (one per template). The episode JSON lives at
// episodes/<slug>.json — strip the template suffix to find it. A bare
// slug (no suffix) is rejected so the user explicitly chooses which
// template to render.
const { slug, variantSuffix } = parseCompositionId(compositionId);
if (!variantSuffix) {
  console.error(
    `Composition id must end in -flow, -bars, -race, or -battle. Got: ${compositionId}`,
  );
  console.error(`  Try: npm run render ${compositionId}-bars`);
  process.exit(1);
}

const { episode, paths } = await loadEpisode(slug, variantSuffix);
const { root: ROOT, outDir: OUT_DIR, outFile: OUT_FILE } = paths;

// The race & top-battle templates are physics-driven and require a
// baked simulation result instead of per-item cover validation. (The
// top-battle template DOES use cover images on the top face, so we still
// check covers separately for it.) Flow/bars only need covers.
if (variantSuffix === "-race") {
  if (!episode.raceResult || !episode.raceBakePath) {
    console.error(
      `Race bake missing. Run: npm run race-roll ${slug}`,
    );
    process.exit(1);
  }
  const bakeFile = path.join(ROOT, "public", episode.raceBakePath);
  if (!existsSync(bakeFile)) {
    console.error(
      `Race bake file referenced by episode JSON not found: ${bakeFile}`,
    );
    console.error(`  Re-run: npm run race-roll ${slug}`);
    process.exit(1);
  }
} else if (variantSuffix === "-battle") {
  if (!episode.battleResult || !episode.battleBakePath) {
    console.error(
      `Battle bake missing. Run: npm run battle-roll ${slug}`,
    );
    process.exit(1);
  }
  const bakeFile = path.join(ROOT, "public", episode.battleBakePath);
  if (!existsSync(bakeFile)) {
    console.error(
      `Battle bake file referenced by episode JSON not found: ${bakeFile}`,
    );
    console.error(`  Re-run: npm run battle-roll ${slug}`);
    process.exit(1);
  }
  // Top-battle also paints covers on each top's top face — verify they
  // exist so the renderer doesn't suspend forever on missing textures.
  const missing = episode.items.filter(
    (it) =>
      !it.imagePath || !existsSync(path.join(ROOT, "public", it.imagePath)),
  );
  if (missing.length > 0) {
    console.error(
      `${missing.length} item(s) missing local images. Run: npm run build-episode ${slug}`,
    );
    for (const it of missing) console.error(`  #${it.rank} ${it.title}`);
    process.exit(1);
  }
} else {
  const missing = episode.items.filter(
    (it) =>
      !it.imagePath || !existsSync(path.join(ROOT, "public", it.imagePath)),
  );
  if (missing.length > 0) {
    console.error(
      `${missing.length} item(s) missing local images. Run: npm run build-episode ${slug}`,
    );
    for (const it of missing) console.error(`  #${it.rank} ${it.title}`);
    process.exit(1);
  }
}

await fs.mkdir(OUT_DIR, { recursive: true });

// Must match AUDIO_FADE_FRAMES (90) at 60 fps in flow-slides / bar-slides
// so the post-mux fade is identical to the studio preview.
const FADE_SECONDS = 1.5;
const hasAudio = !!episode.audioPath;
const audioVolume = episode.audioVolume ?? 0.35;

// Voiceover: a generated narration track (scripts/generate-voiceover.mjs) lives
// at public/voiceover/<slug>/manifest.json. When present, the mux lays each
// narration clip at its timed offset over a DUCKED music bed.
const voiceoverManifestFile = path.join(
  ROOT,
  "public",
  "voiceover",
  slug,
  "manifest.json",
);
const hasVoiceover = existsSync(voiceoverManifestFile);

const args = [
  "remotion",
  "render",
  compositionId,
  OUT_FILE,
  "--codec=h264",
  "--crf=18",
  "--concurrency=6",
  // R3F can take >30s to recover after a browser restart on long renders.
  // 2-min per-handle timeout keeps the render alive across crashes.
  "--timeout=120000",
];
// Mute the render whenever we'll re-add audio in the mux pass (music and/or
// narration), so the in-composition <Audio> music isn't double-applied.
if (hasAudio || hasVoiceover) args.push("--muted");

// Remotion writes thousands of temporary frame PNGs during a render. By
// default these go to the OS temp dir (C: on Windows), which can be tiny —
// a long 1080p render easily spills several GB and dies with ENOSPC. Redirect
// temp to a folder on THIS drive (where the project lives and has room), under
// out/.tmp, and clean it up afterwards. Setting TMPDIR/TEMP/TMP covers Node's
// os.tmpdir() on every platform.
const RENDER_TMP = path.join(OUT_DIR, ".tmp");
await fs.mkdir(RENDER_TMP, { recursive: true });
const childEnv = { ...process.env, TMPDIR: RENDER_TMP, TEMP: RENDER_TMP, TMP: RENDER_TMP };

console.log(`Rendering ${compositionId} → ${path.relative(ROOT, OUT_FILE)}`);
console.log(`  (temp frames → ${path.relative(ROOT, RENDER_TMP)})`);
const child = spawn("npx", args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: childEnv,
});
child.on("exit", async (code) => {
  if (code !== 0) process.exit(code ?? 1);

  if (hasAudio || hasVoiceover) {
    try {
      await muxAudio({
        root: ROOT,
        videoFile: OUT_FILE,
        audioRelPath: episode.audioPath,
        volume: audioVolume,
        fadeSeconds: FADE_SECONDS,
        voiceoverManifestFile: hasVoiceover ? voiceoverManifestFile : null,
      });
    } catch (err) {
      console.error(`\nAudio mux failed: ${err.message}`);
      console.error(`Silent video is at: ${path.relative(ROOT, OUT_FILE)}`);
      process.exit(1);
    }
  }

  // Clean up the redirected temp frames so they don't accumulate on disk.
  await fs.rm(RENDER_TMP, { recursive: true, force: true }).catch(() => {});

  console.log(`\nDone → ${path.relative(ROOT, OUT_FILE)}`);
});

async function muxAudio({
  root,
  videoFile,
  audioRelPath,
  volume,
  fadeSeconds,
  voiceoverManifestFile,
}) {
  const binDir = path.join(
    root,
    "node_modules",
    "@remotion",
    "compositor-win32-x64-msvc",
  );
  const ffmpeg = path.join(binDir, "ffmpeg.exe");
  const ffprobe = path.join(binDir, "ffprobe.exe");

  const hasMusic = !!audioRelPath;
  const audioFile = hasMusic ? path.join(root, "public", audioRelPath) : null;
  if (hasMusic && !existsSync(audioFile)) {
    throw new Error(`Audio file not found: ${audioFile}`);
  }

  const duration = probeDuration(ffprobe, videoFile);

  // Load narration clips (if any).
  let clips = [];
  if (voiceoverManifestFile) {
    const manifest = JSON.parse(await fs.readFile(voiceoverManifestFile, "utf-8"));
    clips = (manifest.clips ?? [])
      .map((c) => ({ ...c, abs: path.join(root, "public", c.file) }))
      .filter((c) => existsSync(c.abs));
  }
  const hasVoice = clips.length > 0;

  // Music gets quieter when narration plays over it (a fixed "duck"); the
  // bundled ffmpeg lacks sidechaincompress, so we use a constant low bed
  // volume rather than dynamic ducking — predictable and clean for narration.
  const musicVol = hasVoice ? Math.min(volume, 0.1) : volume;

  // Triangular fade-in/out envelope, synthesised via `volume` because the
  // bundled ffmpeg whitelist omits `afade`.
  const envelope =
    `max(0,min(min(1,t/${fadeSeconds}),` +
    `min(1,(${duration.toFixed(3)}-t)/${fadeSeconds})))`;

  const tmpOut = videoFile + ".audio.mp4";
  if (existsSync(tmpOut)) await fs.unlink(tmpOut);

  // ── Simple path: music only, no narration (original behaviour). ──
  if (!hasVoice) {
    console.log(
      `Muxing audio (${duration.toFixed(2)}s, fade ${fadeSeconds}s, vol ${musicVol}) ...`,
    );
    const filter = `volume=eval=frame:volume='${envelope}*${musicVol}'`;
    await runFfmpeg(ffmpeg, [
      "-y",
      "-i", videoFile,
      "-stream_loop", "-1", "-i", audioFile,
      "-map", "0:v", "-map", "1:a",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      "-filter:a", filter,
      "-shortest", "-movflags", "+faststart",
      tmpOut,
    ]);
    await fs.unlink(videoFile);
    await fs.rename(tmpOut, videoFile);
    return;
  }

  // ── Voiceover path: narration clips at timed offsets over a ducked bed. ──
  // Inputs: [0] video, [1] music (looped, if any), [2..] narration clips.
  const inputs = ["-y", "-i", videoFile];
  if (hasMusic) inputs.push("-stream_loop", "-1", "-i", audioFile);
  for (const c of clips) inputs.push("-i", c.abs);

  const musicInputIdx = 1;
  const firstClipIdx = hasMusic ? 2 : 1;

  const parts = [];
  const mixLabels = [];
  if (hasMusic) {
    parts.push(
      `[${musicInputIdx}:a]volume=eval=frame:volume='${envelope}*${musicVol}'[mbed]`,
    );
    mixLabels.push("[mbed]");
  }
  clips.forEach((c, i) => {
    const idx = firstClipIdx + i;
    const delayMs = Math.max(0, Math.round((c.startSec ?? 0) * 1000));
    const lbl = `v${i}`;
    // adelay shifts the clip to its cue; volume 1.0 keeps narration upfront.
    parts.push(`[${idx}:a]adelay=${delayMs}:all=1,volume=1.0[${lbl}]`);
    mixLabels.push(`[${lbl}]`);
  });
  // Sum without auto-normalising (clips don't overlap; music is already low).
  parts.push(
    `${mixLabels.join("")}amix=inputs=${mixLabels.length}:normalize=0:dropout_transition=0[aout]`,
  );
  const filterComplex = parts.join(";");

  console.log(
    `Muxing audio + ${clips.length} narration clips ` +
      `(${duration.toFixed(2)}s${hasMusic ? `, music bed vol ${musicVol}` : ", no music"}) ...`,
  );

  await runFfmpeg(ffmpeg, [
    ...inputs,
    "-filter_complex", filterComplex,
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    // Cap output at the video length (looped music is otherwise infinite).
    "-t", duration.toFixed(3),
    "-movflags", "+faststart",
    tmpOut,
  ]);

  await fs.unlink(videoFile);
  await fs.rename(tmpOut, videoFile);
}

function probeDuration(ffprobe, videoFile) {
  const durStr = execFileSync(
    ffprobe,
    [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoFile,
    ],
    { encoding: "utf-8" },
  ).trim();
  const duration = Number(durStr);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe returned unparseable duration: ${JSON.stringify(durStr)}`);
  }
  return duration;
}

function runFfmpeg(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpeg, args, { stdio: "inherit" });
    ff.on("exit", (c) =>
      c === 0 ? resolve() : reject(new Error(`ffmpeg mux exited ${c}`)),
    );
  });
}
