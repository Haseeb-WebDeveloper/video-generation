#!/usr/bin/env node
// Re-schedule already-uploaded videos: PATCH each video's status.publishAt to
// the value currently stored in its episode JSON (episode.youtube.publishAt).
//
// Only the `status` part is updated — title, description, tags and thumbnail
// are left untouched. Scheduling requires privacyStatus="private" (YouTube
// releases it automatically at publishAt), so that's set too.
//
// Needs the youtube.force-ssl (or youtube) scope — videos.update is a write
// call. Re-run scripts/youtube-auth.mjs if you get a 403 scope error.
//
// Video ids come from episodes/<slug>-<variant>.published.json (written by
// set-thumbnails / publish-episode). If a lockfile is missing, the video is
// discovered by its unique country list in the channel's uploads.
//
// Usage:
//   node scripts/reschedule.mjs --dry-run            # show planned changes
//   node scripts/reschedule.mjs                      # apply to spin-01..10
//   node scripts/reschedule.mjs spin-04 spin-05      # specific slugs
//   node scripts/reschedule.mjs --variant=tournament

import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import * as dotenv from "./lib/dotenv.mjs";
import { loadEpisode, episodePaths } from "./lib/episode-loader.mjs";
import { getAccessToken } from "./lib/youtube-auth.mjs";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--") && !a.includes("=")));
const opts = Object.fromEntries(
  argv
    .filter((a) => a.startsWith("--") && a.includes("="))
    .map((a) => {
      const [k, ...v] = a.slice(2).split("=");
      return [k, v.join("=")];
    }),
);
const variant = opts.variant ?? "battle";
const variantSuffix = `-${variant}`;
const dryRun = flags.has("--dry-run");

const slugs =
  argv.filter((a) => !a.startsWith("--")).length > 0
    ? argv.filter((a) => !a.startsWith("--"))
    : Array.from({ length: 10 }, (_, i) => `spin-${String(i + 1).padStart(2, "0")}`);

const root = path.resolve(process.cwd());
const env = await dotenv.load(path.join(root, ".env"));
dotenv.require(env, [
  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "YOUTUBE_REFRESH_TOKEN",
]);

console.log("Authenticating with YouTube…");
const { accessToken } = await getAccessToken({
  clientId: env.YOUTUBE_CLIENT_ID,
  clientSecret: env.YOUTUBE_CLIENT_SECRET,
  refreshToken: env.YOUTUBE_REFRESH_TOKEN,
});

// Resolve a videoId for each slug from its lockfile; collect any that need
// discovery.
const plan = [];
const needDiscovery = [];
for (const slug of slugs) {
  let episode;
  try {
    ({ episode } = await loadEpisode(slug));
  } catch (err) {
    console.error(`✗ ${slug}: ${err.message}`);
    continue;
  }
  const publishAt = episode.youtube?.publishAt;
  if (!publishAt) {
    console.error(`✗ ${slug}: no youtube.publishAt set — run schedule-batch first.`);
    continue;
  }
  const { publishedFile } = episodePaths(slug, variantSuffix);
  let videoId = null;
  if (existsSync(publishedFile)) {
    videoId = JSON.parse(await fs.readFile(publishedFile, "utf-8")).videoId ?? null;
  }
  const entry = { slug, episode, publishAt, videoId, publishedFile };
  plan.push(entry);
  if (!videoId) needDiscovery.push(entry);
}

if (needDiscovery.length > 0) {
  console.log(`Discovering ${needDiscovery.length} video id(s) by description…`);
  const uploads = await fetchAllUploads(accessToken);
  await enrichDescriptions(accessToken, uploads);
  const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
  for (const e of needDiscovery) {
    const sig = norm(e.episode.items.map((it) => it.title).join(", "));
    const m = uploads.find((v) => norm(v.description).includes(sig));
    if (m) e.videoId = m.videoId;
  }
}

let ok = 0;
let failed = 0;
for (const e of plan) {
  if (!e.videoId) {
    console.error(`✗ ${e.slug}: could not resolve a videoId.`);
    failed++;
    continue;
  }
  const line = `${e.slug} → ${e.videoId}  publishAt ${e.publishAt}`;
  if (dryRun) {
    console.log(`(dry-run) ${line}`);
    ok++;
    continue;
  }
  try {
    await patchStatus(accessToken, e.videoId, e.publishAt, e.episode);
    // Keep the lockfile's metadata.publishAt in sync if present.
    if (existsSync(e.publishedFile)) {
      const lock = JSON.parse(await fs.readFile(e.publishedFile, "utf-8"));
      lock.metadata = { ...(lock.metadata ?? {}), publishAt: e.publishAt, privacyStatus: "private" };
      lock.rescheduledAt = new Date().toISOString();
      await fs.writeFile(e.publishedFile, JSON.stringify(lock, null, 2) + "\n");
    }
    console.log(`✓ ${line}`);
    ok++;
  } catch (err) {
    console.error(`✗ ${e.slug}: ${err.message}`);
    failed++;
  }
}

console.log(`\nDone. ${ok} ${dryRun ? "planned" : "rescheduled"}, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);

// ───────────────────────────────────────────────────────────────────────────

async function patchStatus(accessToken, videoId, publishAt, episode) {
  const madeForKids = episode.youtube?.madeForKids ?? false;
  const body = {
    id: videoId,
    status: {
      privacyStatus: "private", // required while a future publishAt is set
      publishAt,
      selfDeclaredMadeForKids: madeForKids,
    },
  };
  const res = await fetch(
    "https://www.googleapis.com/youtube/v3/videos?part=status",
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`videos.update HTTP ${res.status} — ${text}`);
  }
  return res.json();
}

async function fetchAllUploads(accessToken) {
  const ch = await ytGet(accessToken, "channels", {
    part: "contentDetails",
    mine: "true",
  });
  const uploadsId = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) throw new Error("Could not resolve uploads playlist.");
  const out = [];
  let pageToken;
  do {
    const page = await ytGet(accessToken, "playlistItems", {
      part: "snippet,contentDetails",
      playlistId: uploadsId,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    });
    for (const it of page.items ?? []) {
      out.push({
        videoId: it.contentDetails?.videoId ?? it.snippet?.resourceId?.videoId,
        title: it.snippet?.title,
        description: it.snippet?.description,
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

async function enrichDescriptions(accessToken, uploads) {
  for (let i = 0; i < uploads.length; i += 50) {
    const batch = uploads.slice(i, i + 50);
    const data = await ytGet(accessToken, "videos", {
      part: "snippet",
      id: batch.map((v) => v.videoId).join(","),
      maxResults: "50",
    });
    const byId = new Map((data.items ?? []).map((it) => [it.id, it.snippet]));
    for (const v of batch) {
      const sn = byId.get(v.videoId);
      if (sn) v.description = sn.description ?? v.description ?? "";
    }
  }
}

async function ytGet(accessToken, resource, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${resource}.list HTTP ${res.status} — ${text}`);
  }
  return res.json();
}
