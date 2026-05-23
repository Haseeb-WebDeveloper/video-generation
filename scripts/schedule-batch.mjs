#!/usr/bin/env node
// Stamp youtube.publishAt onto a batch of episodes, staggered by N days, so
// YouTube auto-releases one every few days after they're uploaded (private +
// publishAt = scheduled release).
//
// Usage:
//   node scripts/schedule-batch.mjs --start=2026-06-02T17:00:00Z --every=3 \
//     worldcup-01 worldcup-02 worldcup-03 ...
//
// Flags:
//   --start=<ISO>   First publish time (UTC, RFC3339). Required, must be future.
//   --every=<days>  Days between releases. Default 3.

import { loadEpisode, writeEpisode } from "./lib/episode-loader.mjs";

const args = process.argv.slice(2);
const slugs = args.filter((a) => !a.startsWith("--"));
const startArg = args.find((a) => a.startsWith("--start="));
const everyArg = args.find((a) => a.startsWith("--every="));

if (!startArg || slugs.length === 0) {
  console.error(
    "Usage: node scripts/schedule-batch.mjs --start=<ISO-UTC> [--every=3] <slug...>",
  );
  process.exit(1);
}

const start = new Date(startArg.split("=")[1]);
if (Number.isNaN(start.getTime())) {
  console.error(`Invalid --start date: ${startArg.split("=")[1]}`);
  process.exit(1);
}
const everyDays = everyArg ? Number(everyArg.split("=")[1]) : 3;
const DAY_MS = 24 * 60 * 60 * 1000;

if (start.getTime() < Date.now()) {
  console.warn("⚠️  --start is in the past; YouTube rejects past publishAt times.");
}

for (let i = 0; i < slugs.length; i++) {
  const slug = slugs[i];
  const { episode } = await loadEpisode(slug);
  const when = new Date(start.getTime() + i * everyDays * DAY_MS).toISOString();
  const yt = { ...(episode.youtube ?? {}) };
  yt.publishAt = when;
  // publishAt requires the upload to be private; publish-episode enforces this,
  // but set it here too for clarity.
  yt.privacyStatus = "private";
  episode.youtube = yt;
  await writeEpisode(slug, episode);
  console.log(`${slug}  →  publishAt ${when}`);
}

console.log(`\nScheduled ${slugs.length} episodes, one every ${everyDays} day(s).`);
