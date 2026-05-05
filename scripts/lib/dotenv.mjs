// Tiny .env helper: parse a KEY=value file into an object, and upsert a
// single key in place without disturbing comments or unrelated entries.
// Sufficient for the project's three OAuth secrets; not a general dotenv.

import fs from "node:fs/promises";
import { existsSync } from "node:fs";

export async function load(envFile) {
  if (!existsSync(envFile)) return {};
  const raw = await fs.readFile(envFile, "utf-8");
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

export async function upsert(envFile, key, value) {
  let raw = existsSync(envFile) ? await fs.readFile(envFile, "utf-8") : "";
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(raw)) {
    raw = raw.replace(re, line);
  } else {
    if (raw.length > 0 && !raw.endsWith("\n")) raw += "\n";
    raw += line + "\n";
  }
  await fs.writeFile(envFile, raw);
}

export function require(env, keys) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing in .env: ${missing.join(", ")}. Run: npm run youtube-auth`,
    );
  }
}
