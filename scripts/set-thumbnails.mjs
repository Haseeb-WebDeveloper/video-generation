#!/usr/bin/env node
// Apply (or re-apply) custom thumbnails to videos that are ALREADY uploaded.
//
// The cloud render workflow publishes videos but never commits the
// episodes/<slug>-<variant>.published.json lockfiles back, so locally we don't
// know each video's YouTube id. This script discovers the id by matching the
// episode's youtube.title against the channel's uploads playlist, then uploads
// public/<thumbnailPath> via thumbnails.set (compressed under YouTube's 2MB cap
// with the same tiered logic publish-episode uses).
//
// On success it also writes episodes/<slug>-<variant>.published.json so future
// `publish-episode --update` runs work without re-discovery.
//
// Two ways to know each video's id:
//   1. Auto-discovery (needs the youtube.readonly scope — re-run youtube-auth).
//   2. An explicit map you pass with --ids=<file.json>, where the file is
//      { "spin-01": "VIDEOID_or_URL", ... }. With a complete map, NO read scope
//      is needed — thumbnails.set works with the youtube.upload scope alone.
//
// Usage:
//   node scripts/set-thumbnails.mjs --list                 # list channel uploads, exit
//   node scripts/set-thumbnails.mjs --dry-run              # show matches, no upload
//   node scripts/set-thumbnails.mjs                        # all spin-01..10 (discovery)
//   node scripts/set-thumbnails.mjs spin-03 spin-07        # specific slugs
//   node scripts/set-thumbnails.mjs --ids=episodes/video-ids.json   # explicit map
//   node scripts/set-thumbnails.mjs --variant=tournament   # match -tournament lockfiles

import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import sharp from "sharp";
import * as dotenv from "./lib/dotenv.mjs";
import { loadEpisode, episodePaths } from "./lib/episode-loader.mjs";
import { getAccessToken } from "./lib/youtube-auth.mjs";

const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

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
const listOnly = flags.has("--list");
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

// Optional explicit slug→videoId map. Accepts a bare id or a full URL.
const idMap = {};
if (opts.ids) {
  const raw = JSON.parse(await fs.readFile(path.join(root, opts.ids), "utf-8"));
  for (const [k, v] of Object.entries(raw)) idMap[k] = parseVideoId(v);
}
// With a complete id map (and not listing), we never need the read scope.
const haveAllIds =
  !listOnly && slugs.every((s) => idMap[s]);

console.log("Authenticating with YouTube…");
const { accessToken } = await getAccessToken({
  clientId: env.YOUTUBE_CLIENT_ID,
  clientSecret: env.YOUTUBE_CLIENT_SECRET,
  refreshToken: env.YOUTUBE_REFRESH_TOKEN,
});

let uploads = [];
if (!haveAllIds) {
  console.log("Fetching channel uploads…");
  uploads = await fetchAllUploads(accessToken);
  // Episode titles aren't unique (they're built from the first 3 countries),
  // so we match on the FULL description, which lists all 10 countries in order.
  // playlistItems descriptions can be truncated → fetch full snippets.
  await enrichDescriptions(accessToken, uploads);
  console.log(`Found ${uploads.length} video(s) on the channel.\n`);
}

if (listOnly) {
  for (const v of uploads) {
    console.log(
      `${v.videoId}  ${v.publishedAt?.slice(0, 10) ?? "????-??-??"}  ${v.title}`,
    );
  }
  process.exit(0);
}

const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
// Track which videos we've already claimed so two episodes can't map to the
// same upload (defensive — the country signature should already be unique).
const claimed = new Set();

let ok = 0;
let failed = 0;

for (const slug of slugs) {
  let episode, paths;
  try {
    ({ episode, paths } = await loadEpisode(slug));
  } catch (err) {
    console.error(`✗ ${slug}: ${err.message}`);
    failed++;
    continue;
  }

  let picked;
  if (idMap[slug]) {
    // Explicit id provided — no discovery needed.
    const known = uploads.find((v) => v.videoId === idMap[slug]);
    picked = known ?? { videoId: idMap[slug], title: episode.youtube?.title ?? slug, publishedAt: null };
  } else {
    // Unique signature = the ordered list of all this episode's countries.
    // It appears verbatim in the uploaded description, so it disambiguates
    // episodes that share a (non-unique) title.
    const signature = norm(episode.items.map((it) => it.title).join(", "));
    let matches = uploads.filter(
      (v) => !claimed.has(v.videoId) && norm(v.description).includes(signature),
    );
    if (matches.length === 0) {
      // Fallback: exact full-description equality.
      const wantDesc = norm(episode.youtube?.description);
      matches = uploads.filter(
        (v) => !claimed.has(v.videoId) && norm(v.description) === wantDesc,
      );
    }
    if (matches.length === 0) {
      console.error(
        `✗ ${slug}: no uploaded video's description lists [${signature}].`,
      );
      failed++;
      continue;
    }
    matches.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
    picked = matches[0];
    if (matches.length > 1) {
      console.warn(
        `! ${slug}: ${matches.length} videos match this country list — using newest ${picked.videoId} (${picked.publishedAt?.slice(0, 10)}).`,
      );
    }
    claimed.add(picked.videoId);
  }

  let thumb;
  try {
    thumb = await resolveThumbnail(episode, paths);
  } catch (err) {
    console.error(`✗ ${slug}: ${err.message}`);
    failed++;
    continue;
  }
  if (!thumb) {
    console.error(`✗ ${slug}: no thumbnailPath set on the episode.`);
    failed++;
    continue;
  }

  const label =
    `${slug} → ${picked.videoId}  "${truncate(picked.title, 48)}"  ` +
    `[${thumb.tier} ${thumb.width}×${thumb.height} q${thumb.quality} ${formatBytes(thumb.buf.length)}]`;

  if (dryRun) {
    console.log(`(dry-run) ${label}`);
    ok++;
    continue;
  }

  try {
    const set = await uploadThumbnail(accessToken, picked.videoId, thumb);
    await writeLockfile(slug, variantSuffix, picked, episode, thumb, set);
    console.log(`✓ ${label}`);
    ok++;
  } catch (err) {
    console.error(`✗ ${slug}: thumbnail upload failed — ${err.message}`);
    failed++;
  }
}

console.log(`\nDone. ${ok} ${dryRun ? "matched" : "set"}, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);

// ───────────────────────────────────────────────────────────────────────────

async function fetchAllUploads(accessToken) {
  const ch = await ytGet(accessToken, "channels", {
    part: "contentDetails",
    mine: "true",
  });
  const uploadsId =
    ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads ?? null;
  if (!uploadsId) {
    throw new Error("Could not resolve the channel's uploads playlist.");
  }
  const out = [];
  let pageToken;
  do {
    const page = await ytGet(accessToken, "playlistItems", {
      part: "snippet,contentDetails,status",
      playlistId: uploadsId,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    });
    for (const it of page.items ?? []) {
      out.push({
        videoId: it.contentDetails?.videoId ?? it.snippet?.resourceId?.videoId,
        title: it.snippet?.title,
        publishedAt:
          it.contentDetails?.videoPublishedAt ?? it.snippet?.publishedAt,
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

// playlistItems can return truncated descriptions; videos.list?part=snippet
// returns the full text. Batches up to 50 ids per call and attaches
// `.description` to each upload entry in place.
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
      if (sn) {
        v.description = sn.description ?? v.description ?? "";
        v.title = sn.title ?? v.title;
      }
    }
  }
}

async function ytGet(accessToken, resource, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${resource}.list failed: HTTP ${res.status} — ${text}`);
  }
  return res.json();
}

async function uploadThumbnail(accessToken, videoId, thumb) {
  const url =
    `https://www.googleapis.com/upload/youtube/v3/thumbnails/set` +
    `?videoId=${encodeURIComponent(videoId)}&uploadType=media`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "image/jpeg",
      "Content-Length": String(thumb.buf.length),
    },
    body: thumb.buf,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`thumbnails.set HTTP ${res.status} — ${text}`);
  }
  return res.json();
}

// Same tiered compression as publish-episode.mjs: native → 1080p → 720p,
// dropping JPEG quality until the result fits under 2MB.
async function resolveThumbnail(episode, paths) {
  if (!episode.thumbnailPath) return null;
  const abs = path.join(paths.root, "public", episode.thumbnailPath);
  if (!existsSync(abs)) {
    throw new Error(
      `thumbnailPath "${episode.thumbnailPath}" but no file at ${abs}.`,
    );
  }
  const meta = await sharp(abs).metadata();
  const tiers = [
    { width: meta.width, height: meta.height, label: "native" },
    { width: 1920, height: 1080, label: "1080p" },
    { width: 1280, height: 720, label: "720p" },
  ];
  for (const t of tiers) {
    for (const quality of [92, 88, 84, 78, 72, 65]) {
      const buf = await sharp(abs)
        .rotate()
        .resize({
          width: t.width,
          height: t.height,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (buf.length <= THUMBNAIL_MAX_BYTES) {
        const final = await sharp(buf).metadata();
        return {
          buf,
          width: final.width,
          height: final.height,
          tier: t.label,
          quality,
          source: episode.thumbnailPath,
        };
      }
    }
  }
  throw new Error(
    `Could not compress ${episode.thumbnailPath} under 2MB even at 720p q65.`,
  );
}

async function writeLockfile(slug, variantSuffix, picked, episode, thumb, apiResponse) {
  const { publishedFile } = episodePaths(slug, variantSuffix);
  const existing = existsSync(publishedFile)
    ? JSON.parse(await fs.readFile(publishedFile, "utf-8"))
    : {};
  const lock = {
    ...existing,
    videoId: picked.videoId,
    url: `https://youtu.be/${picked.videoId}`,
    uploadedAt: existing.uploadedAt ?? picked.publishedAt ?? new Date().toISOString(),
    discoveredVia: "set-thumbnails (title match)",
    thumbnail: {
      source: thumb.source,
      uploadedWidth: thumb.width,
      uploadedHeight: thumb.height,
      uploadedBytes: thumb.buf.length,
      tier: thumb.tier,
      quality: thumb.quality,
      etag: apiResponse?.etag ?? null,
      setAt: new Date().toISOString(),
    },
  };
  await fs.writeFile(publishedFile, JSON.stringify(lock, null, 2) + "\n");
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(s, n) {
  return (s ?? "").length > n ? (s ?? "").slice(0, n - 1) + "…" : s ?? "";
}

// Accept a bare video id or any YouTube URL form (youtu.be/ID, watch?v=ID,
// /shorts/ID) and return the 11-char id.
function parseVideoId(s) {
  const t = String(s).trim();
  const m =
    t.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
    t.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
    t.match(/\/shorts\/([A-Za-z0-9_-]{11})/) ||
    t.match(/^([A-Za-z0-9_-]{11})$/);
  return m ? m[1] : t;
}
