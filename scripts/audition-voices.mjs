#!/usr/bin/env node
// Generate the SAME sample narration in several Edge neural voices so you can
// listen and pick the one you like best. Free, no API key.
//
// Usage:
//   node scripts/audition-voices.mjs              # all the curated voices
//   node scripts/audition-voices.mjs --all-male   # every en-* male voice
//   node scripts/audition-voices.mjs "Custom line to speak"
//
// Output: out/voice-audition/<voice>.mp3  (filename = voice id, so you know
// which is which). Open the folder and play them.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(
  ROOT,
  "out",
  process.argv.includes("--batch2") ? "voice-audition-2" : "voice-audition",
);

// A line with a count, a name, a value, and the dramatic #1 build — so you can
// judge how each voice handles the actual job.
const DEFAULT_LINE =
  "Number three: Nauru, at seventy percent. " +
  "And the worst of all… American Samoa. Seventy-six percent of adults.";

// Curated shortlist — the most attractive / suspense-friendly male + a couple
// of female options. Multilingual variants tend to sound the warmest.
const CURATED = [
  "en-US-BrianMultilingualNeural",
  "en-US-AndrewMultilingualNeural",
  "en-US-GuyNeural",
  "en-US-DavisNeural",
  "en-US-ChristopherNeural",
  "en-US-EricNeural",
  "en-GB-RyanNeural",
  "en-AU-WilliamNeural",
  "en-US-AvaMultilingualNeural", // female, warm
  "en-US-EmmaMultilingualNeural", // female, friendly
];

// A second, WIDER batch — different accents you may not have heard, plus the
// remaining US voices. Run with --batch2.
const BATCH2 = [
  "en-US-RogerNeural", // lively
  "en-US-SteffanNeural", // rational, narrator-ish
  "en-US-AndrewNeural", // warm/confident (non-multilingual)
  "en-US-BrianNeural", // approachable/casual (non-multilingual)
  "en-GB-ThomasNeural", // British male
  "en-IE-ConnorNeural", // Irish male
  "en-CA-LiamNeural", // Canadian male
  "en-NZ-MitchellNeural", // New Zealand male
  "en-ZA-LukeNeural", // South African male
  "en-AU-WilliamMultilingualNeural", // Australian, multilingual (warmer)
  "en-US-AriaNeural", // female, confident
  "en-GB-SoniaNeural", // British female
];

const args = process.argv.slice(2);
const customLine = args.find((a) => !a.startsWith("--"));
const line = customLine || DEFAULT_LINE;
const rate = "+8%";

let voices = CURATED;
if (args.includes("--batch2")) {
  voices = BATCH2;
} else if (args.includes("--all-male")) {
  // A broader male set if you want more options.
  voices = [
    "en-US-BrianMultilingualNeural",
    "en-US-AndrewMultilingualNeural",
    "en-US-BrandonNeural",
    "en-US-GuyNeural",
    "en-US-DavisNeural",
    "en-US-JasonNeural",
    "en-US-TonyNeural",
    "en-US-ChristopherNeural",
    "en-US-EricNeural",
    "en-US-RogerNeural",
    "en-US-SteffanNeural",
    "en-GB-RyanNeural",
    "en-GB-ThomasNeural",
    "en-AU-WilliamNeural",
    "en-CA-LiamNeural",
  ];
}

await fs.mkdir(OUT, { recursive: true });
console.log(`Auditioning ${voices.length} voices → ${path.relative(ROOT, OUT)}\n`);
console.log(`Line: "${line}"\n`);

for (const voice of voices) {
  process.stdout.write(`  ${voice.padEnd(34)} … `);
  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(line, { rate });
    const chunks = [];
    await new Promise((resolve, reject) => {
      audioStream.on("data", (c) => chunks.push(c));
      audioStream.on("end", resolve);
      audioStream.on("error", reject);
    });
    const buf = Buffer.concat(chunks);
    await fs.writeFile(path.join(OUT, `${voice}.mp3`), buf);
    console.log(`${(buf.length / 1024).toFixed(0)}KB`);
  } catch (err) {
    console.log(`FAILED (${err.message})`);
  }
}

console.log(
  `\nDone. Open ${path.relative(ROOT, OUT)} and play the clips.\n` +
    `Pick the filename you like, then set it:\n` +
    `  EDGE_VOICE_ID=<that-voice-id>   in .env   (applies to every episode)\n` +
    `  or per-run:  npm run voiceover <slug> -- --voice=<that-voice-id> --force`,
);
