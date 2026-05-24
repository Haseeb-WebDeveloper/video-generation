// Build YouTube metadata for an episode.
//
// As of the strict-SEO refactor: title, description, and tags MUST be
// authored by hand in episodes/<slug>.json under the `youtube` block. There
// is no auto-fallback that derives them from the slug or items list — if you
// want the video published, you write the SEO yourself.
//
// The one convenience: a literal `{{chapters}}` token in `youtube.description`
// gets replaced with the auto-computed chapter timestamp block. Chapters are
// derived from item count and PER_ITEM_FRAMES, so hand-authoring them would
// just be error-prone duplication.

import { computeChapters } from "./chapters.mjs";

const TITLE_HARD_LIMIT = 100;
const DESCRIPTION_LIMIT = 5000;
const TAGS_HARD_LIMIT = 500;

export function buildMetadata(episode) {
  const yt = episode.youtube;
  if (!yt) {
    throw new Error(
      `episodes/${episode.slug}.json is missing the required "youtube" block. ` +
        `Add youtube.title, youtube.description, and youtube.tags before publishing.`,
    );
  }
  const missing = ["title", "description", "tags"].filter((k) => {
    const v = yt[k];
    if (k === "tags") return !Array.isArray(v) || v.length === 0;
    return typeof v !== "string" || v.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new Error(
      `episodes/${episode.slug}.json youtube block is missing: ${missing.join(", ")}. ` +
        `These fields must be authored by hand — no auto-fallback.`,
    );
  }

  const chapters = computeChapters(episode);
  const description = injectChapters(yt.description, chapters);

  return {
    title: yt.title,
    description,
    tags: yt.tags,
    chapters,
    categoryId: yt.categoryId ?? "24",
    privacyStatus: yt.privacyStatus ?? "private",
    madeForKids: yt.madeForKids ?? false,
    publishAt: yt.publishAt,
    defaultLanguage: yt.defaultLanguage ?? "en",
  };
}

function injectChapters(description, chapters) {
  if (!description.includes("{{chapters}}")) return description;
  const block = chapters.map((c) => `${c.time} ${c.label}`).join("\n");
  return description.replace(/\{\{chapters\}\}/g, block);
}

// YouTube counts the comma-separated string length, with quotes added around
// any tag that contains a space. We mirror that so we don't overshoot 500.
function joinedLen(tags) {
  return tags
    .map((t) => (t.includes(" ") ? `"${t}"` : t))
    .join(",")
    .length;
}

export function validateMetadata(meta) {
  const errors = [];
  if (meta.title.length > TITLE_HARD_LIMIT) {
    errors.push(`title is ${meta.title.length} chars (limit ${TITLE_HARD_LIMIT})`);
  }
  if (meta.description.length > DESCRIPTION_LIMIT) {
    errors.push(
      `description is ${meta.description.length} chars (limit ${DESCRIPTION_LIMIT})`,
    );
  }
  const tagsLen = joinedLen(meta.tags);
  if (tagsLen > TAGS_HARD_LIMIT) {
    errors.push(`tags total ${tagsLen} chars (limit ${TAGS_HARD_LIMIT})`);
  }
  // Chapters are optional (single battles/races have none). Only validate the
  // structure when chapters are present (e.g. tournaments, ranked lists).
  if (meta.chapters.length > 0) {
    if (meta.chapters[0].time !== "0:00") {
      errors.push(`first chapter must be 0:00, got ${meta.chapters[0].time}`);
    }
    if (meta.chapters.length < 3) {
      errors.push(`only ${meta.chapters.length} chapters; need ≥ 3`);
    }
    for (let i = 1; i < meta.chapters.length; i++) {
      if (meta.chapters[i].frame <= meta.chapters[i - 1].frame) {
        errors.push(`chapter ${i} not strictly after chapter ${i - 1}`);
        break;
      }
    }
  }
  if (!["private", "unlisted", "public"].includes(meta.privacyStatus)) {
    errors.push(`invalid privacyStatus "${meta.privacyStatus}"`);
  }
  return errors;
}
