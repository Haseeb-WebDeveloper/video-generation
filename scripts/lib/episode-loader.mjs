// Shared episode loader. Used by build-episode, render-episode, publish-episode.
//
// loadEpisode(slug) reads episodes/<slug>.json, validates that its internal
// "slug" field matches the argv slug, and returns the parsed object alongside
// every absolute path the pipeline scripts need.

import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

export function episodePaths(slug) {
  const root = path.resolve(process.cwd());
  return {
    root,
    episodeFile: path.join(root, "episodes", `${slug}.json`),
    coversDir: path.join(root, "public", "covers", slug),
    outDir: path.join(root, "out"),
    outFile: path.join(root, "out", `${slug}.mp4`),
    publishedFile: path.join(root, "episodes", `${slug}.published.json`),
    uploadStateFile: path.join(root, "out", `${slug}.upload-state.json`),
    envFile: path.join(root, ".env"),
  };
}

export async function loadEpisode(slug) {
  const paths = episodePaths(slug);
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
