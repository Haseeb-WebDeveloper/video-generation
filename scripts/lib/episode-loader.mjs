// Shared episode loader. Used by build-episode, render-episode, publish-episode.
//
// loadEpisode(slug) reads episodes/<slug>.json, validates that its internal
// "slug" field matches the argv slug, and returns the parsed object alongside
// every absolute path the pipeline scripts need.
//
// Composition IDs in Root.tsx are <slug>-flow / <slug>-bars (one per template).
// One episode JSON drives both templates, but each variant has its own MP4 /
// publish lockfile / resumable upload-state. parseCompositionId() splits a
// composition id into { slug, variantSuffix }; episodePaths(slug, variantSuffix)
// applies the suffix only to the variant-specific paths.

import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

export const TEMPLATE_SUFFIXES = ["-flow", "-bars", "-race", "-battle"];

export function parseCompositionId(input) {
  for (const suf of TEMPLATE_SUFFIXES) {
    if (input.endsWith(suf)) {
      return { slug: input.slice(0, -suf.length), variantSuffix: suf };
    }
  }
  return { slug: input, variantSuffix: "" };
}

export function episodePaths(slug, variantSuffix = "") {
  const root = path.resolve(process.cwd());
  const variantName = `${slug}${variantSuffix}`;
  return {
    root,
    episodeFile: path.join(root, "episodes", `${slug}.json`),
    coversDir: path.join(root, "public", "covers", slug),
    outDir: path.join(root, "out"),
    outFile: path.join(root, "out", `${variantName}.mp4`),
    publishedFile: path.join(root, "episodes", `${variantName}.published.json`),
    uploadStateFile: path.join(root, "out", `${variantName}.upload-state.json`),
    envFile: path.join(root, ".env"),
  };
}

export async function loadEpisode(slug, variantSuffix = "") {
  const paths = episodePaths(slug, variantSuffix);
  if (!existsSync(paths.episodeFile)) {
    throw new Error(`Episode JSON not found: ${paths.episodeFile}`);
  }
  const raw = await fs.readFile(paths.episodeFile, "utf-8");
  const episode = JSON.parse(raw);
  if (episode.slug !== slug) {
    throw new Error(
      `Episode slug mismatch: file has "${episode.slug}", argv has "${slug}".`,
    );
  }
  return { episode, paths };
}

export async function writeEpisode(slug, episode) {
  const { episodeFile } = episodePaths(slug);
  await fs.writeFile(episodeFile, JSON.stringify(episode, null, 2) + "\n");
}
