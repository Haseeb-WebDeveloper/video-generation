// Build YouTube metadata for an episode.
//
// Generates a search-friendly title, a description with chapter timestamps
// front-loaded into the first ~150 chars (the search snippet), and a tag set
// trimmed to YouTube's 500-char limit. Per-episode overrides via the optional
// `youtube` block on the Episode object.

import { computeChapters } from "./chapters.mjs";

const TITLE_HARD_LIMIT = 100;
const TITLE_PREFERRED_LIMIT = 70;
const DESCRIPTION_LIMIT = 5000;
const TAGS_HARD_LIMIT = 500;
const TAGS_TARGET_LIMIT = 480;

export function buildMetadata(episode, opts = {}) {
  const yt = episode.youtube ?? {};
  const year = opts.year ?? new Date().getFullYear();
  const { topic, count } = parseSlug(episode.slug, episode.items.length);
  const chapters = computeChapters(episode);

  const title = yt.title ?? buildTitle(episode, year);
  const description =
    yt.description ?? buildDescription(episode, chapters, topic, count, year);
  const tags = buildTags(episode, topic, count, year);

  return {
    title,
    description,
    tags,
    chapters,
    categoryId: yt.categoryId ?? "24",
    privacyStatus: yt.privacyStatus ?? "private",
    madeForKids: yt.madeForKids ?? false,
    publishAt: yt.publishAt,
    defaultLanguage: yt.defaultLanguage ?? "en",
  };
}

function buildTitle(episode, year) {
  const suffix = ` (${year})`;
  const full = `${episode.title[0]} ${episode.title[1]}${suffix}`;
  if (full.length <= TITLE_PREFERRED_LIMIT) return full;
  const short = `${episode.title[0]}${suffix}`;
  if (short.length <= TITLE_HARD_LIMIT) return short;
  return short.slice(0, TITLE_HARD_LIMIT - 1) + "…";
}

function buildDescription(episode, chapters, topic, count, year) {
  const hook = `The definitive ranking of the ${topic} in ${year}. We count down from #${count} to #1 — here are the winners.`;
  const chapterLines = chapters.map((c) => `${c.time} ${c.label}`).join("\n");
  const yt = episode.youtube ?? {};
  const hashtags = (yt.hashtags ?? defaultHashtags(topic, count, year)).join(" ");

  const parts = [
    hook,
    "",
    "⏱ Chapters",
    chapterLines,
    "",
    `🔔 Subscribe for more Top ${count} lists every week.`,
    `🎬 Episode: ${episode.title[0]} ${episode.title[1]}`,
    "",
    `Sources: ranking compiled from public data. Numbers in ${episode.unitLabel}.`,
    "",
    hashtags,
  ];

  let body = parts.join("\n");
  if (body.length > DESCRIPTION_LIMIT) body = body.slice(0, DESCRIPTION_LIMIT);
  return body;
}

function buildTags(episode, topic, count, year) {
  const yt = episode.youtube ?? {};
  if (yt.tags) {
    return trimTags([...yt.tags, ...(yt.extraTags ?? [])]);
  }
  const items = [...episode.items].sort((a, b) => a.rank - b.rank);
  const topicWords = topic.split(/\s+/).filter(Boolean);
  const auto = [
    `top ${count}`,
    topic,
    ...topicWords,
    String(year),
    `${year} ranking`,
    ...items.slice(0, 5).map((i) => i.title),
    "ranking",
    "list",
    "countdown",
  ];
  return trimTags([...auto, ...(yt.extraTags ?? [])]);
}

function trimTags(tags) {
  const seen = new Set();
  const deduped = tags.filter((t) => {
    if (!t || typeof t !== "string") return false;
    const k = t.toLowerCase().trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  while (joinedLen(deduped) > TAGS_TARGET_LIMIT && deduped.length > 1) {
    deduped.pop();
  }
  return deduped;
}

// YouTube counts the comma-separated string length, with quotes added around
// any tag that contains a space. We mirror that so we don't overshoot 500.
function joinedLen(tags) {
  return tags
    .map((t) => (t.includes(" ") ? `"${t}"` : t))
    .join(",")
    .length;
}

function parseSlug(slug, itemCount) {
  const m = slug.match(/^top-(\d+)-(.+)$/);
  if (m) {
    return { count: Number(m[1]), topic: m[2].replace(/-/g, " ") };
  }
  return { count: itemCount, topic: slug.replace(/-/g, " ") };
}

function defaultHashtags(topic, count, year) {
  const camelTopic = topic
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  return [`#Top${count}`, `#${camelTopic}`, `#Ranking`, `#${year}`];
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
  if (!["private", "unlisted", "public"].includes(meta.privacyStatus)) {
    errors.push(`invalid privacyStatus "${meta.privacyStatus}"`);
  }
  return errors;
}
