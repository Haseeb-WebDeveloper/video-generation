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
if (hasAudio) args.push("--muted");

console.log(`Rendering ${compositionId} → ${path.relative(ROOT, OUT_FILE)}`);
const child = spawn("npx", args, {
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("exit", async (code) => {
  if (code !== 0) process.exit(code ?? 1);

  if (hasAudio) {
    try {
      await muxAudio({
        root: ROOT,
        videoFile: OUT_FILE,
        audioRelPath: episode.audioPath,
        volume: audioVolume,
        fadeSeconds: FADE_SECONDS,
      });
    } catch (err) {
      console.error(`\nAudio mux failed: ${err.message}`);
      console.error(`Silent video is at: ${path.relative(ROOT, OUT_FILE)}`);
      process.exit(1);
    }
  }

  console.log(`\nDone → ${path.relative(ROOT, OUT_FILE)}`);
});

async function muxAudio({ root, videoFile, audioRelPath, volume, fadeSeconds }) {
  const binDir = path.join(
    root,
    "node_modules",
    "@remotion",
    "compositor-win32-x64-msvc",
  );
  const ffmpeg = path.join(binDir, "ffmpeg.exe");
  const ffprobe = path.join(binDir, "ffprobe.exe");
  const audioFile = path.join(root, "public", audioRelPath);

  if (!existsSync(audioFile)) {
    throw new Error(`Audio file not found: ${audioFile}`);
  }

  const durStr = execFileSync(
    ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoFile,
    ],
    { encoding: "utf-8" },
  ).trim();
  const duration = Number(durStr);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe returned unparseable duration: ${JSON.stringify(durStr)}`);
  }
  const fadeOutStart = Math.max(0, duration - fadeSeconds);

  // Remotion's bundled ffmpeg is built with --disable-filters plus a
  // narrow whitelist that does NOT include `afade`, so we synthesise the
  // same linear fade-in / fade-out via the `volume` filter with a
  // per-sample expression. min(in,out) gives the same triangular envelope
  // as `Math.min(fadeIn,fadeOut)` in flow-slides.tsx; max(0,…) just clamps
  // against the rounding error around t≈duration.
  const filter =
    `volume=eval=frame:volume='max(0,min(min(1,t/${fadeSeconds}),` +
    `min(1,(${duration.toFixed(3)}-t)/${fadeSeconds})))*${volume}'`;

  const tmpOut = videoFile + ".audio.mp4";
  if (existsSync(tmpOut)) await fs.unlink(tmpOut);

  console.log(
    `Muxing audio (${duration.toFixed(2)}s, fade ${fadeSeconds}s, vol ${volume}) ...`,
  );

  await new Promise((resolve, reject) => {
    const ff = spawn(
      ffmpeg,
      [
        "-y",
        "-i",
        videoFile,
        "-stream_loop",
        "-1",
        "-i",
        audioFile,
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-filter:a",
        filter,
        "-shortest",
        "-movflags",
        "+faststart",
        tmpOut,
      ],
      { stdio: "inherit" },
    );
    ff.on("exit", (c) =>
      c === 0 ? resolve() : reject(new Error(`ffmpeg mux exited ${c}`)),
    );
  });

  await fs.unlink(videoFile);
  await fs.rename(tmpOut, videoFile);
}
