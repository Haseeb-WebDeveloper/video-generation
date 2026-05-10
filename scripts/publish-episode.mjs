#!/usr/bin/env node
// Upload one episode to YouTube with auto-generated SEO metadata.
//
// Usage:
//   node scripts/publish-episode.mjs <slug> [flags]
//
// Flags:
//   --dry-run         Print metadata + chapter list and exit (no upload).
//   --force           Re-upload as a NEW video even if a lockfile exists.
//                     The previous videoId is preserved in previousUploads[].
//   --update          PATCH the existing video's metadata in place. No re-upload.
//                     Requires a lockfile from a prior successful upload.
//   --privacy=<v>     Override privacyStatus for this run (private|unlisted|public).
//
// On success, writes episodes/<slug>.published.json (the publish ledger).
// On mid-upload failure, writes out/<slug>.upload-state.json and the next
// run resumes from the last byte the YouTube server confirmed.
//
// First-time setup: see scripts/youtube-auth.mjs.

import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import sharp from "sharp";
import * as dotenv from "./lib/dotenv.mjs";
import { loadEpisode } from "./lib/episode-loader.mjs";
import { buildMetadata, validateMetadata } from "./lib/youtube-meta.mjs";
import { chaptersWillAutoDetect } from "./lib/chapters.mjs";
import { getAccessToken } from "./lib/youtube-auth.mjs";

const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith("--"));
const flags = new Set(argv.filter((a) => a.startsWith("--") && !a.includes("=")));
const opts = Object.fromEntries(
  argv
    .filter((a) => a.startsWith("--") && a.includes("="))
    .map((a) => {
      const [k, ...v] = a.slice(2).split("=");
      return [k, v.join("=")];
    }),
);

if (!slug) {
  console.error(
    "Usage: node scripts/publish-episode.mjs <slug> [--dry-run] [--force] [--update] [--privacy=<v>]",
  );
  process.exit(1);
}

const dryRun = flags.has("--dry-run");
const force = flags.has("--force");
const update = flags.has("--update");
if (force && update) {
  console.error("--force and --update are mutually exclusive.");
  process.exit(1);
}

const { episode, paths } = await loadEpisode(slug);
const meta = buildMetadata(episode);
if (opts.privacy) meta.privacyStatus = opts.privacy;

const errors = validateMetadata(meta);
if (errors.length > 0) {
  console.error("Metadata validation failed:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const mp4Exists = existsSync(paths.outFile);
const mp4Stat = mp4Exists ? await fs.stat(paths.outFile) : null;

const existingLock = existsSync(paths.publishedFile)
  ? JSON.parse(await fs.readFile(paths.publishedFile, "utf-8"))
  : null;

const thumbnailInfo = await resolveThumbnail(episode, paths);

if (dryRun) {
  printDryRun({ slug, meta, mp4Stat, existingLock, thumbnailInfo });
  process.exit(0);
}

if (!mp4Exists) {
  console.error(
    `MP4 not found: ${paths.outFile}. Run: npm run render ${slug}`,
  );
  process.exit(1);
}

if (existingLock && !force && !update) {
  const sameFile =
    existingLock.fileBytes === mp4Stat.size &&
    existingLock.fileMtime === mp4Stat.mtime.toISOString();
  if (sameFile) {
    console.error(
      `Already published as ${existingLock.url} (uploaded ${existingLock.uploadedAt}).\n` +
        `  --update : PATCH that video's metadata only (no re-upload).\n` +
        `  --force  : upload this MP4 as a NEW video.`,
    );
    process.exit(1);
  }
  console.error(
    `Lockfile exists for a different MP4 (size/mtime differ). ` +
      `Re-run with --force to upload as a new video.`,
  );
  process.exit(1);
}

if (update && !existingLock) {
  console.error(`--update requires an existing ${path.relative(paths.root, paths.publishedFile)}.`);
  process.exit(1);
}

const env = await dotenv.load(paths.envFile);
dotenv.require(env, [
  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "YOUTUBE_REFRESH_TOKEN",
]);

console.log(`Authenticating with YouTube…`);
const { accessToken } = await getAccessToken({
  clientId: env.YOUTUBE_CLIENT_ID,
  clientSecret: env.YOUTUBE_CLIENT_SECRET,
  refreshToken: env.YOUTUBE_REFRESH_TOKEN,
});

if (update) {
  const videoId = existingLock.videoId;
  console.log(`Updating metadata for ${videoId}…`);
  const updated = await patchVideo(accessToken, videoId, meta);
  let thumbResult = existingLock.thumbnail ?? null;
  if (thumbnailInfo) {
    console.log(
      `Updating thumbnail (${thumbnailInfo.width}×${thumbnailInfo.height}, ${formatBytes(thumbnailInfo.buf.length)})…`,
    );
    const set = await uploadThumbnail(accessToken, videoId, thumbnailInfo);
    thumbResult = serializableThumbnail(thumbnailInfo, set);
  }
  await writeLockfile(paths.publishedFile, {
    ...existingLock,
    metadata: serializableMeta(meta),
    thumbnail: thumbResult,
    updatedAt: new Date().toISOString(),
  });
  console.log(`\nUpdated → https://youtu.be/${updated.id}`);
  process.exit(0);
}

console.log(`Uploading ${path.relative(paths.root, paths.outFile)} (${formatBytes(mp4Stat.size)})…`);
const video = await resumableUpload({
  accessToken,
  filePath: paths.outFile,
  fileSize: mp4Stat.size,
  meta,
  uploadStateFile: paths.uploadStateFile,
});

let thumbResult = null;
if (thumbnailInfo) {
  console.log(
    `Uploading thumbnail (${thumbnailInfo.width}×${thumbnailInfo.height}, ${formatBytes(thumbnailInfo.buf.length)})…`,
  );
  try {
    const set = await uploadThumbnail(accessToken, video.id, thumbnailInfo);
    thumbResult = serializableThumbnail(thumbnailInfo, set);
    console.log(`  Thumbnail set.`);
  } catch (err) {
    // Don't fail the whole publish if just the thumbnail breaks — the video
    // is already up. Surface the error and let the user retry with --update.
    console.error(`  Thumbnail upload failed: ${err.message}`);
    console.error(`  Re-run with --update once the issue is fixed.`);
  }
}

const lock = {
  videoId: video.id,
  uploadedAt: new Date().toISOString(),
  url: `https://youtu.be/${video.id}`,
  metadata: serializableMeta(meta),
  thumbnail: thumbResult,
  fileBytes: mp4Stat.size,
  fileMtime: mp4Stat.mtime.toISOString(),
};
if (force && existingLock) {
  lock.previousUploads = [
    ...(existingLock.previousUploads ?? []),
    {
      videoId: existingLock.videoId,
      uploadedAt: existingLock.uploadedAt,
      url: existingLock.url,
    },
  ];
}
await writeLockfile(paths.publishedFile, lock);
if (existsSync(paths.uploadStateFile)) await fs.unlink(paths.uploadStateFile);

console.log(`\n✓ Uploaded → ${lock.url}`);
console.log(`  Privacy: ${meta.privacyStatus}`);
if (!chaptersWillAutoDetect(meta.chapters)) {
  console.log(
    `  Note: chapter timestamps are listed in the description but YT won't auto-render\n` +
      `        them as clickable jumps — gaps are < 10s with current PER_ITEM_FRAMES.`,
  );
}
console.log(`\nNext steps in YT Studio (https://studio.youtube.com):`);
let nextStep = 1;
if (!thumbnailInfo) {
  console.log(
    `  ${nextStep++}. Upload a custom thumbnail (set "thumbnailPath" in the JSON to automate).`,
  );
}
console.log(`  ${nextStep++}. Confirm "Audience" → not made for kids.`);
console.log(`  ${nextStep++}. Add to a playlist if applicable.`);
console.log(`  ${nextStep++}. Review the Checks tab for copyright issues on cover images.`);
console.log(`  ${nextStep++}. Flip privacy from private → public when ready.`);

// ───────────────────────────────────────────────────────────────────────────

async function resumableUpload({
  accessToken,
  filePath,
  fileSize,
  meta,
  uploadStateFile,
}) {
  let uploadUrl;
  let resuming = false;
  if (existsSync(uploadStateFile)) {
    const state = JSON.parse(await fs.readFile(uploadStateFile, "utf-8"));
    if (state.fileSize === fileSize && state.uploadUrl) {
      console.log(`  Resuming previous upload session…`);
      uploadUrl = state.uploadUrl;
      resuming = true;
    } else {
      await fs.unlink(uploadStateFile);
    }
  }

  if (!uploadUrl) {
    uploadUrl = await initResumableSession({ accessToken, fileSize, meta });
    await fs.writeFile(
      uploadStateFile,
      JSON.stringify({ uploadUrl, fileSize, startedAt: new Date().toISOString() }, null, 2),
    );
  }

  let received = 0;
  if (resuming) {
    const probe = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": "0",
        "Content-Range": `bytes */${fileSize}`,
      },
    });
    if (probe.status === 200 || probe.status === 201) {
      return await probe.json();
    }
    if (probe.status === 308) {
      const range = probe.headers.get("Range");
      const m = range?.match(/bytes=0-(\d+)/);
      received = m ? Number(m[1]) + 1 : 0;
      if (received > 0) {
        console.log(`  Server has bytes 0-${received - 1}; resuming.`);
      }
    } else if (probe.status === 404 || probe.status === 410) {
      console.warn(`  Upload session expired; restarting.`);
      await fs.unlink(uploadStateFile);
      return await resumableUpload({
        accessToken,
        filePath,
        fileSize,
        meta,
        uploadStateFile,
      });
    }
  }

  const buf = await fs.readFile(filePath);
  const slice = received > 0 ? buf.subarray(received) : buf;
  const headers = {
    "Content-Type": "video/mp4",
    "Content-Length": String(slice.length),
  };
  if (received > 0) {
    headers["Content-Range"] = `bytes ${received}-${fileSize - 1}/${fileSize}`;
  }
  const res = await fetch(uploadUrl, { method: "PUT", headers, body: slice });
  if (!res.ok && res.status !== 308) {
    const text = await res.text();
    throw new Error(`Upload PUT failed: HTTP ${res.status} — ${text}`);
  }
  return await res.json();
}

async function initResumableSession({ accessToken, fileSize, meta }) {
  const url =
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
  const body = videoResource(meta);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(fileSize),
      "X-Upload-Content-Type": "video/mp4",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    if (text.includes("quotaExceeded")) {
      throw new Error(
        "YouTube API quota exceeded. Default daily quota is 10,000 units; " +
          "videos.insert costs 1,600 each. Request more at " +
          "https://support.google.com/youtube/contact/yt_api_form",
      );
    }
    throw new Error(`Resumable init failed: HTTP ${res.status} — ${text}`);
  }
  const location = res.headers.get("Location");
  if (!location) throw new Error("Resumable init: no Location header in response.");
  return location;
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
    throw new Error(`thumbnails.set failed: HTTP ${res.status} — ${text}`);
  }
  return await res.json();
}

// Resolve the episode's thumbnailPath to a buffer that fits YouTube's
// 2MB cap. Tries native res first, then 1080p, then 720p, dropping JPEG
// quality at each tier until something fits. Returns null if no thumbnail
// is configured for this episode (publish proceeds without one).
async function resolveThumbnail(episode, paths) {
  if (!episode.thumbnailPath) return null;
  const abs = path.join(paths.root, "public", episode.thumbnailPath);
  if (!existsSync(abs)) {
    throw new Error(
      `thumbnailPath set to "${episode.thumbnailPath}" but no file at ${abs}.`,
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
    `Could not compress ${episode.thumbnailPath} under 2MB even at 1280×720 q=65.`,
  );
}

function serializableThumbnail(thumb, apiResponse) {
  return {
    source: thumb.source,
    uploadedWidth: thumb.width,
    uploadedHeight: thumb.height,
    uploadedBytes: thumb.buf.length,
    tier: thumb.tier,
    quality: thumb.quality,
    etag: apiResponse?.etag ?? null,
  };
}

async function patchVideo(accessToken, videoId, meta) {
  const url = "https://www.googleapis.com/youtube/v3/videos?part=snippet,status";
  const body = { id: videoId, ...videoResource(meta) };
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Update failed: HTTP ${res.status} — ${text}`);
  }
  return await res.json();
}

function videoResource(meta) {
  const status = {
    privacyStatus: meta.privacyStatus,
    madeForKids: meta.madeForKids,
    selfDeclaredMadeForKids: meta.madeForKids,
  };
  if (meta.publishAt) {
    status.publishAt = meta.publishAt;
    status.privacyStatus = "private";
  }
  return {
    snippet: {
      title: meta.title,
      description: meta.description,
      tags: meta.tags,
      categoryId: meta.categoryId,
      defaultLanguage: meta.defaultLanguage,
    },
    status,
  };
}

async function writeLockfile(file, lock) {
  await fs.writeFile(file, JSON.stringify(lock, null, 2) + "\n");
}

function serializableMeta(meta) {
  return {
    title: meta.title,
    description: meta.description,
    tags: meta.tags,
    categoryId: meta.categoryId,
    privacyStatus: meta.privacyStatus,
    madeForKids: meta.madeForKids,
    publishAt: meta.publishAt ?? null,
    defaultLanguage: meta.defaultLanguage,
  };
}

function printDryRun({ slug, meta, mp4Stat, existingLock, thumbnailInfo }) {
  const ruler = "─".repeat(70);
  console.log(`\n${ruler}\nDRY RUN: ${slug}\n${ruler}`);
  console.log(`MP4: ${mp4Stat ? formatBytes(mp4Stat.size) : "NOT YET RENDERED"}`);
  if (existingLock) {
    console.log(`Lockfile: published as ${existingLock.url} on ${existingLock.uploadedAt}`);
  }
  console.log(`\nTitle (${meta.title.length} chars):`);
  console.log(`  ${meta.title}`);
  console.log(`\nDescription (${meta.description.length} chars):`);
  console.log(indent(withSnippetMarker(meta.description), "  "));
  console.log(`\nTags (${meta.tags.length} tags, joined ${joinedTagLen(meta.tags)} chars):`);
  console.log(`  ${meta.tags.join(" | ")}`);
  console.log(`\nChapters (${meta.chapters.length}, auto-detect ${chaptersWillAutoDetect(meta.chapters) ? "YES" : "NO"}):`);
  for (const c of meta.chapters) console.log(`  ${c.time}  ${c.label}`);
  console.log(`\nCategory: ${meta.categoryId}    Privacy: ${meta.privacyStatus}    Kids: ${meta.madeForKids}`);
  if (meta.publishAt) console.log(`Scheduled publish: ${meta.publishAt}`);
  if (thumbnailInfo) {
    console.log(
      `\nThumbnail: ${thumbnailInfo.source} → ${thumbnailInfo.width}×${thumbnailInfo.height} ` +
        `(${thumbnailInfo.tier}, q${thumbnailInfo.quality}, ${formatBytes(thumbnailInfo.buf.length)})`,
    );
  } else {
    console.log(`\nThumbnail: (none — set "thumbnailPath" in the JSON to upload one)`);
  }
  console.log(`\nValidation: PASS\n${ruler}\n`);
}

function withSnippetMarker(description) {
  if (description.length <= 150) return description;
  const cut = 150;
  return (
    description.slice(0, cut) +
    "\n  └── (≈150-char search snippet boundary above) ──\n" +
    description.slice(cut)
  );
}

function indent(text, prefix) {
  return text
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function joinedTagLen(tags) {
  return tags
    .map((t) => (t.includes(" ") ? `"${t}"` : t))
    .join(",")
    .length;
}
