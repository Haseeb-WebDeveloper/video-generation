import fs from "node:fs/promises";
import path from "node:path";

// Steam app IDs for games on Steam — preferred, gives clean 600x900 box art
const STEAM_IDS = {
  2: 271590,   // GTA V
  5: 578080,   // PUBG
  7: 1174180,  // RDR2
  8: 489830,   // Skyrim Special Edition
  9: 105600,   // Terraria
  11: 292030,  // Witcher 3
  15: 477160,  // Human: Fall Flat
  17: 990080,  // Hogwarts Legacy
  19: 2000950, // CoD MW 2019 (campaign remaster)
};

// Wikipedia article titles for fallback HTML-scrape
const WIKI_TITLES = {
  1: "Minecraft",
  3: "Tetris (Electronic Arts)",
  4: "Wii Sports",
  6: "Mario Kart 8",
  10: "Super Mario Bros.",
  12: "Pokémon Red and Blue",
  13: "Animal Crossing: New Horizons",
  14: "Wii Fit",
  16: "Mario Kart Wii",
  18: "Diablo III",
  20: "New Super Mario Bros.",
};

const OUT = path.resolve("public/covers");
await fs.mkdir(OUT, { recursive: true });

const UA = "VideoBuilder/1.0 (offline-render)";
const manifest = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, opts, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, opts);
    if (res.status === 429) {
      await sleep(1500 * (i + 1));
      continue;
    }
    return res;
  }
  return null;
}

async function trySteam(rank) {
  const id = STEAM_IDS[rank];
  if (!id) return null;
  const url = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${id}/library_600x900.jpg`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 5000) return null;
  return { buf, ext: "jpg", source: `steam:${id}` };
}

async function tryWikipedia(rank) {
  const title = WIKI_TITLES[rank];
  if (!title) return null;
  const slug = title.replace(/ /g, "_");
  const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(slug)}`;
  const res = await fetchWithRetry(url, { headers: { "User-Agent": UA } });
  if (!res || !res.ok) return null;
  const html = await res.text();
  // Find the first "real" image in the article — prefer larger (jpg or png) thumbs
  // Match BOTH thumb URLs and full-size (non-thumb) URLs. Wikipedia serves
  // fair-use cover art as non-thumb originals.
  const matches = [
    ...html.matchAll(
      /"\/\/upload\.wikimedia\.org\/wikipedia\/(?:en|commons)\/(?:thumb\/[^"]+?\/(\d+)px-[^"]+?\.(?:jpg|png)|[a-f0-9]\/[a-f0-9]{2}\/[^"]+?\.(?:jpg|png))"/g,
    ),
  ];
  const SKIP_NAMES = /(Cscr-|Semi-protection|Symbol_|Edit-icon|Question_book|Padlock|Wikidata|Disambig|OOjs_UI|Wikisource|Wiktionary|Commons-logo|People_icon|Lock-)/i;
  const candidates = matches
    .map((m) => {
      const url = m[0].slice(1, -1);
      const isThumb = url.includes("/thumb/");
      const size = m[1] ? parseInt(m[1], 10) : 999;
      return { url, isThumb, size };
    })
    .filter(
      (c) =>
        !c.url.includes(".svg/") &&
        !c.url.endsWith(".svg") &&
        c.size >= 100 &&
        !SKIP_NAMES.test(c.url),
    );
  if (candidates.length === 0) return null;
  const first = candidates[0];
  const upgraded = first.isThumb
    ? first.url.replace(/\/\d+px-/, "/500px-")
    : first.url;
  const ext = upgraded.toLowerCase().endsWith(".png") ? "png" : "jpg";
  const fullUrl = "https:" + upgraded;
  const imgRes = await fetchWithRetry(fullUrl, { headers: { "User-Agent": UA } });
  if (!imgRes || !imgRes.ok) return null;
  const buf = Buffer.from(await imgRes.arrayBuffer());
  if (buf.length < 3000) return null;
  return { buf, ext, source: `wiki:${title}` };
}

for (let rank = 1; rank <= 20; rank++) {
  let result = await trySteam(rank);
  if (!result) result = await tryWikipedia(rank);
  if (!result) {
    console.log(`MISS  #${rank}`);
    await sleep(400);
    continue;
  }
  const filename = `${rank}.${result.ext}`;
  await fs.writeFile(path.join(OUT, filename), result.buf);
  manifest[rank] = filename;
  console.log(
    `OK    #${rank} ${result.source} → ${filename} (${(result.buf.length / 1024).toFixed(0)}KB)`,
  );
  await sleep(400);
}

await fs.writeFile(
  path.join(OUT, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);
console.log(`\nWrote manifest with ${Object.keys(manifest).length} of 20.`);
