#!/usr/bin/env node
// Generate an AI voiceover track for a flow-template episode.
//
// DEFAULT engine is FREE Microsoft Edge neural TTS (no API key, no credits, no
// "Unusual activity detected" IP blocks) via `msedge-tts`. ElevenLabs is an
// opt-in premium engine when you have credits.
//
// Usage:
//   node scripts/generate-voiceover.mjs <slug> [--engine=edge|eleven] [--voice=<id>] [--dry-run] [--force]
//
// Reads:
//   episodes/<slug>.json                     (items + values)
//   episodes/voiceover/<slug>.script.json     (OPTIONAL hand-written lines)
//
// Writes:
//   public/voiceover/<slug>/<id>.mp3          (one clip per narration line)
//   public/voiceover/<slug>/manifest.json     (clip id → startSec, for the mux)
//
// The render step (scripts/render-episode.mjs) picks up the manifest and lays
// each clip at its start time over a ducked music bed.
//
// Engines:
//   edge   (default, FREE) — Microsoft Edge online neural voices, no key.
//          voice = a short name like en-US-AndrewNeural (see VOICEOVER.md).
//          Override the default with EDGE_VOICE_ID in .env.
//   eleven (premium)       — ElevenLabs; needs ELEVENLABS_API_KEY in .env,
//          voice = an ElevenLabs voice id (or ELEVENLABS_VOICE_ID in .env).
//
// Script file format (episodes/voiceover/<slug>.script.json):
//   {
//     "hook":  "Some countries work themselves into the ground...",
//     "outro": "So — where does your country land? Tell me below.",
//     "items": { "1": "And number one will genuinely surprise you...", ... }
//   }
// Any line you omit is auto-generated from a template. `items` is keyed by RANK.

import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import * as dotenv from "./lib/dotenv.mjs";
import { buildSchedule } from "./lib/voiceover-timing.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FFPROBE = path.join(
  ROOT,
  "node_modules",
  "@remotion",
  "compositor-win32-x64-msvc",
  "ffprobe.exe",
);

// Exact audio length of a clip, in seconds (for sequential, non-overlapping
// layout). Falls back to a word-count estimate if ffprobe is unavailable.
function probeDurationSec(file) {
  try {
    const out = execFileSync(
      FFPROBE,
      [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        file,
      ],
      { encoding: "utf-8" },
    ).trim();
    const d = Number(out);
    if (Number.isFinite(d) && d > 0) return d;
  } catch {
    // fall through to estimate
  }
  return 3; // safe fallback
}

// Default free narrator: Andrew is a warm, natural US male documentary voice.
// Good alternatives: en-US-BrianNeural, en-US-GuyNeural, en-US-ChristopherNeural,
// en-US-EmmaNeural (f), en-US-AvaNeural (f).
const DEFAULT_EDGE_VOICE = "en-US-AndrewNeural";
const DEFAULT_ELEVEN_VOICE = "pNInz6obpgDQGcFmaJgB"; // Adam

const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith("--"));
const opts = Object.fromEntries(
  argv
    .filter((a) => a.startsWith("--") && a.includes("="))
    .map((a) => a.slice(2).split("=")),
);
const force = argv.includes("--force");
const dryRun = argv.includes("--dry-run");

if (!slug) {
  console.error("Usage: node scripts/generate-voiceover.mjs <slug> [--engine=edge|eleven] [--voice=<id>] [--dry-run] [--force]");
  process.exit(1);
}

const env = await dotenv.load(path.join(ROOT, ".env"));
const engine = (opts.engine || env.VOICEOVER_ENGINE || "edge").toLowerCase();

let apiKey, voiceId, modelId;
if (engine === "eleven") {
  apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey && !dryRun) {
    console.error(
      "Engine 'eleven' needs ELEVENLABS_API_KEY in .env.\n" +
        "  Drop --engine to use the free default (Microsoft Edge TTS), or add:\n" +
        "  ELEVENLABS_API_KEY=sk_...",
    );
    process.exit(1);
  }
  voiceId = opts.voice || env.ELEVENLABS_VOICE_ID || DEFAULT_ELEVEN_VOICE;
  modelId = opts.model || "eleven_multilingual_v2";
} else if (engine === "edge") {
  voiceId = opts.voice || env.EDGE_VOICE_ID || DEFAULT_EDGE_VOICE;
  modelId = "edge-neural";
} else {
  console.error(`Unknown --engine "${engine}". Use "edge" (free, default) or "eleven".`);
  process.exit(1);
}

// Faster delivery so the commentary feels energetic and the viewer never waits
// on the next card. Override with EDGE_RATE in .env (e.g. "+5%", "+15%").
const EDGE_RATE = env.EDGE_RATE || "+10%";

const episodePath = path.join(ROOT, "episodes", `${slug}.json`);
if (!existsSync(episodePath)) {
  console.error(`No episode at ${path.relative(ROOT, episodePath)}`);
  process.exit(1);
}
const episode = JSON.parse(await fs.readFile(episodePath, "utf-8"));

const scriptPath = path.join(ROOT, "episodes", "voiceover", `${slug}.script.json`);
const script = existsSync(scriptPath)
  ? JSON.parse(await fs.readFile(scriptPath, "utf-8"))
  : {};

const schedule = buildSchedule(episode);
const lines = buildLines(schedule, episode, script);

// Dry run: print the narration script in reveal order, generate nothing.
// (Exact cue times are derived from the real audio lengths at generation time,
// so they're only known after synthesis — not shown here.)
if (dryRun) {
  const words = lines.reduce((n, l) => n + (l.text ? l.text.split(/\s+/).length : 0), 0);
  console.log(`\nNarration script for "${slug}" (${lines.filter((l) => l.text).length} lines, ~${words} words):\n`);
  for (const l of lines) {
    if (!l.text) continue;
    console.log(`  [${l.kind === "item" ? "#" + l.rank : l.kind}]  ${l.text}`);
  }
  console.log(`\n(dry run — no audio generated. Remove --dry-run to produce clips with the "${engine}" engine.)`);
  process.exit(0);
}

console.log(`Engine: ${engine} | voice: ${voiceId}`);

const outDir = path.join(ROOT, "public", "voiceover", slug);
await fs.mkdir(outDir, { recursive: true });

// Edge TTS reuses one configured session for the whole batch.
const edge = engine === "edge" ? await makeEdge(voiceId) : null;

// ── Step 1: synthesise every clip to disk ──
let generated = 0;
let skipped = 0;
const rendered = [];
for (const line of lines) {
  if (!line.text) continue;
  const file = path.join(outDir, `${line.id}.mp3`);
  const rel = path.relative(path.join(ROOT, "public"), file).replace(/\\/g, "/");
  if (existsSync(file) && !force) {
    skipped++;
  } else {
    process.stdout.write(`  [${line.id}] ${truncate(line.text, 60)} … `);
    const buf =
      engine === "edge"
        ? await edge.synth(line.text)
        : await ttsEleven(line.text, { apiKey, voiceId, modelId });
    await fs.writeFile(file, buf);
    console.log(`${(buf.length / 1024).toFixed(0)}KB`);
    generated++;
  }
  rendered.push({ ...line, file, rel, abs: file });
}

// ── Step 2: AUDIO-DRIVEN timeline ──
// Measure each clip and lay them out SEQUENTIALLY so they never overlap and
// the gaps between lines are uniform — it should sound like one continuous
// commentary, not a stack of disjointed parts. Each clip starts when the
// previous one finishes, plus a small, role-appropriate breath:
//   - after the hook   → a longer beat before the countdown begins
//   - between items    → a short, even gap so it flows
//   - before the outro → a beat to let the #1 reveal land
// Tighter gaps + faster delivery (see EDGE_RATE) keep the pace snappy so the
// viewer never waits on the next card.
const GAP_AFTER_HOOK = 0.4; // seconds of silence after the hook
const GAP_BETWEEN = 0.28; // brief breath between item lines
const GAP_BEFORE_OUTRO = 0.7; // let the #1 reveal land before the CTA
const LEAD_IN = 0.4; // silence before the very first word

let cursor = LEAD_IN;
const clips = [];
for (let i = 0; i < rendered.length; i++) {
  const r = rendered[i];
  const dur = probeDurationSec(r.abs);
  clips.push({
    id: r.id,
    kind: r.kind,
    startSec: round2(cursor),
    durationSec: round2(dur),
    file: r.rel,
    text: r.text,
  });
  // Advance the cursor past this clip + the appropriate gap.
  let gap = GAP_BETWEEN;
  if (r.kind === "hook") gap = GAP_AFTER_HOOK;
  const next = rendered[i + 1];
  if (next && next.kind === "outro") gap = GAP_BEFORE_OUTRO;
  cursor += dur + gap;
}
const totalAudioSec = round2(cursor - GAP_BETWEEN + 0.5); // last gap → small tail

const manifest = {
  slug,
  engine,
  voiceId,
  modelId,
  fps: 60,
  // The composition reads these so the video length and the camera reveals
  // follow the actual narration. One timeline for every template.
  totalAudioSec,
  leadInSec: LEAD_IN,
  clips,
};
await fs.writeFile(
  path.join(outDir, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);

console.log(
  `\nVoiceover ready: ${generated} generated, ${skipped} reused → ${path.relative(ROOT, outDir)}`,
);
console.log(
  `Sequential timeline: ${clips.length} clips, ${totalAudioSec.toFixed(1)}s total (no overlaps).`,
);
console.log(`Preview/render will follow this timing: npm run dev  ·  npm run render ${slug}-flow`);

// ───────────────────────────────────────────────────────────────────────────
// NATURAL COMMENTARY GENERATION
//
// Goal: lines that sound like a real person narrating, not a label reader.
// We vary the opener per item, call out milestones ("halfway", "top five"),
// REACT to big jumps between consecutive values, and build suspense near #1.
// A hand-written line in episodes/voiceover/<slug>.script.json always wins,
// so you can override any line. Everything here is DETERMINISTIC (seeded by
// rank) so re-running produces identical audio — no surprise re-renders.

// Resolve every clip's text in one pass so item lines can see their neighbours
// (needed to react to value jumps). Returns the schedule clips with `.text`.
function buildLines(schedule, episode, script) {
  const items = schedule.filter((c) => c.kind === "item");
  const N = items.length;
  return schedule.map((clip) => {
    if (clip.kind === "hook") return { ...clip, text: script.hook ?? defaultHook(episode) };
    if (clip.kind === "outro") return { ...clip, text: script.outro ?? defaultOutro(episode) };
    const custom = script.items?.[String(clip.rank)];
    if (custom) return { ...clip, text: custom };
    // revealIndex: 0 = first revealed (highest rank number), N-1 = #1.
    const revealIndex = items.findIndex((it) => it.id === clip.id);
    const prev = revealIndex > 0 ? items[revealIndex - 1] : null;
    return { ...clip, text: defaultItemLine(clip, prev, revealIndex, N, episode) };
  });
}

function unit(episode) {
  return (episode.unitLabel ?? "").trim();
}

// Spoken form of a value+unit. Expands abbreviations so TTS says them properly
// ("16.8 liters", not "sixteen point eight L"; "per 100k" → "per hundred thousand").
// Also handles the value FORMATS so money/counts are spoken naturally.
function spoken(value, episode) {
  const fmt = episode.valueFormat;
  // Money in billions → speak as dollars, scaling to trillions where apt.
  if (fmt === "usd" && typeof value === "number") {
    if (value >= 1000) {
      const t = value / 1000;
      return `${Number.isInteger(t) ? t : t.toFixed(1)} trillion dollars`;
    }
    return `${value.toLocaleString("en-US")} billion dollars`;
  }
  // Counts in millions → "102 million" (+ unit word like "barrels"/"visitors").
  if (fmt === "millions" && typeof value === "number") {
    const tail = unit(episode) ? ` ${unit(episode)}` : "";
    if (value >= 1000) {
      const b = value / 1000;
      return `${Number.isInteger(b) ? b : b.toFixed(1)} billion${tail}`;
    }
    return `${value.toLocaleString("en-US")} million${tail}`;
  }
  const u = unit(episode);
  const n = typeof value === "number" ? value.toLocaleString("en-US") : value;
  if (!u) return `${n}`;
  const map = {
    "%": `${n} percent`,
    liters: `${n} liters`,
    "per 1k": `${n} per thousand`,
    "per 100k": `${n} per hundred thousand`,
    "days/year": `${n} days a year`,
    "DDD/1k": `${n} doses per thousand people`,
    "hrs/year": `${n} hours a year`,
    tonnes: `${n} tonnes`,
    warheads: `${n} warheads`,
    "barrels": `${n} billion barrels`,
  };
  return map[u] ?? `${n} ${u}`;
}

// Deterministic pick from a list, seeded by an integer (the rank) so the same
// item always gets the same phrasing across runs.
function pick(list, seed) {
  return list[((seed % list.length) + list.length) % list.length];
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

// Simple, basic intro — just states what the list is. No gimmick.
function defaultHook(episode) {
  const subject = (episode.title ?? []).join(" ").replace(/\s+/g, " ").trim();
  return `Here are the ${episode.items.length} ${subject.toLowerCase()}.`;
}

// One human-sounding line per item. The key is VARIETY: real commentary
// doesn't say "Number 11… Number 10… Number 9" every single time. We rotate
// through many sentence shapes — some name the rank, many don't — seeded by
// reveal order so it's deterministic but never repeats the same pattern twice
// in a row. #1 always gets a proper reveal.
function defaultItemLine(clip, prev, revealIndex, N, episode) {
  const v = spoken(clip.value, episode);
  const name = clip.title;
  const rank = clip.rank;

  // ── The number one reveal — always emphatic, varied. ──
  if (rank === 1) {
    return pick(
      [
        `And the number one… ${name}. ${v}.`,
        `Which leaves number one. ${name} — ${v}.`,
        `And right at the top, ${name}. ${v}.`,
        `Topping the entire list… ${name}, at ${v}.`,
      ],
      revealIndex,
    );
  }

  // ── Optional milestone tag, occasionally, to anchor the countdown. ──
  let tag = "";
  if (revealIndex === Math.floor(N / 2)) tag = "We're halfway. ";
  else if (rank === 10 && N > 12) tag = "Into the top ten. ";
  else if (rank === 5) tag = "Top five now. ";
  else if (rank === 3) tag = "The top three. ";

  // ── Sentence shapes. Two pools: with-rank and without-rank. We lean on
  // without-rank so it doesn't feel like a robotic counter, but sprinkle the
  // rank back in (and always on milestones) so viewers can still follow. ──
  const withRank = [
    `number ${rank} is ${name}, at ${v}.`,
    `at number ${rank}, ${name} — ${v}.`,
    `${name} lands at number ${rank}, with ${v}.`,
    `in ${ordinal(rank)} place, ${name}. ${v}.`,
    `that puts ${name} at number ${rank} — ${v}.`,
  ];
  const withoutRank = [
    `then there's ${name}, at ${v}.`,
    `next up, ${name} — ${v}.`,
    `${name} comes in at ${v}.`,
    `we've also got ${name}, sitting at ${v}.`,
    `${name} isn't far behind, at ${v}.`,
    `then ${name}, with ${v}.`,
    `${name} makes the list too — ${v}.`,
    `after that, ${name}, at ${v}.`,
  ];

  // Roughly every 3rd line names the rank; milestones always do. The rest
  // skip the number entirely so it sounds like a person talking, not a tally.
  // Spread the seed so adjacent lines rarely land on the same phrasing
  // (a simple ×7 stride walks the pool instead of stepping by 1).
  // Only ~1 in 4 lines names the number (plus milestones) so it sounds like a
  // person talking, not a tally — and shorter lines keep the pace up.
  const useRank = tag !== "" || revealIndex % 4 === 0;
  let body = useRank
    ? pick(withRank, revealIndex * 7 + 1)
    : pick(withoutRank, revealIndex * 7 + 3);

  // Always capitalise the body's first letter (sentence start, even after a
  // milestone tag which ends in ". ").
  body = body.charAt(0).toUpperCase() + body.slice(1);

  let line = tag + body;

  // Occasional reaction to a big jump — but not every time (every other one).
  if (
    prev &&
    typeof clip.value === "number" &&
    typeof prev.value === "number" &&
    prev.value > 0 &&
    clip.value / prev.value >= 1.5 &&
    revealIndex % 2 === 0
  ) {
    line += " " + pick(["Quite a jump.", "Big step up there.", "That's a real leap."], revealIndex);
  }

  return line;
}

// Simple sign-off.
function defaultOutro() {
  return pick(
    [
      `Did your country make the list? Let me know down in the comments.`,
      `Where does your country land? Tell me in the comments below.`,
      `Was your country on there? Drop it in the comments.`,
    ],
    0,
  );
}

// ── Free engine: Microsoft Edge neural TTS via msedge-tts ──
// Returns { synth(text) -> Buffer }, reusing one configured TTS session.
// EDGE_RATE (defined near the top) speeds delivery up so the commentary feels
// energetic and the viewer never waits on the next card.
async function makeEdge(voiceId) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  return {
    async synth(text) {
      const { audioStream } = tts.toStream(text, { rate: EDGE_RATE });
      const chunks = [];
      await new Promise((resolve, reject) => {
        audioStream.on("data", (c) => chunks.push(c));
        audioStream.on("end", resolve);
        audioStream.on("error", reject);
      });
      return Buffer.concat(chunks);
    },
  };
}

// ── Premium engine: ElevenLabs ──
async function ttsEleven(text, { apiKey, voiceId, modelId }) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`ElevenLabs TTS failed: HTTP ${res.status} — ${t}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
