#!/usr/bin/env node
// Scaffold a new episode JSON + register it in episodes/index.ts.
//
// Usage:
//   node scripts/new-episode.mjs <slug> [titleLine1] [titleLine2]
//
// Example:
//   node scripts/new-episode.mjs top-10-most-streamed-songs "TOP 10 MOST-STREAMED" "SONGS OF ALL TIME"

import fs from "node:fs/promises";
import path from "node:path";

const [, , slug, titleLine1, titleLine2] = process.argv;

if (!slug) {
  console.error(
    "Usage: node scripts/new-episode.mjs <slug> [titleLine1] [titleLine2]",
  );
  process.exit(1);
}
if (!/^[a-z0-9-]+$/.test(slug)) {
  console.error("slug must be kebab-case ASCII (a-z0-9-)");
  process.exit(1);
}

const ROOT = path.resolve(process.cwd());
const EPISODES_DIR = path.join(ROOT, "episodes");
const EPISODE_FILE = path.join(EPISODES_DIR, `${slug}.json`);
const INDEX_FILE = path.join(EPISODES_DIR, "index.ts");

await fs.mkdir(EPISODES_DIR, { recursive: true });

try {
  await fs.access(EPISODE_FILE);
  console.error(`Episode already exists: ${EPISODE_FILE}`);
  process.exit(1);
} catch {
  // ok — file doesn't exist
}

const stub = {
  slug,
  title: [titleLine1 ?? "TOP X", titleLine2 ?? "EPISODE TITLE"],
  outro: ["THANKS FOR WATCHING", "Like & subscribe for more"],
  unitLabel: "units",
  items: [],
};

await fs.writeFile(EPISODE_FILE, JSON.stringify(stub, null, 2) + "\n");
console.log(`Created ${path.relative(ROOT, EPISODE_FILE)}`);

await regenerateIndex();
console.log(`Updated ${path.relative(ROOT, INDEX_FILE)}`);

async function regenerateIndex() {
  const files = (await fs.readdir(EPISODES_DIR))
    .filter((f) => f.endsWith(".json") && !f.endsWith(".published.json"))
    .sort();

  const importLines = files
    .map((f) => {
      const base = f.replace(/\.json$/, "");
      const ident = toIdent(base);
      return `import ${ident} from "./${f}";`;
    })
    .join("\n");

  const arrayItems = files
    .map((f) => {
      const base = f.replace(/\.json$/, "");
      return `  ${toIdent(base)} as Episode,`;
    })
    .join("\n");

  const body = `// Auto-maintained by scripts/new-episode.mjs. Safe to hand-edit.
import type { Episode } from "../src/episode";
${importLines}

export const episodes: Episode[] = [
${arrayItems}
];
`;
  await fs.writeFile(INDEX_FILE, body);
}

function toIdent(slug) {
  return slug.replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}
