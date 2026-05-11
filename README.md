# Top X Ranking Video Generator

Remotion + React Three Fiber pipeline for producing 1920×1080 ranking videos. One JSON file describes an episode (rank, title, value, image source); the build pipeline fetches images, optionally strips backgrounds and adds country flags; the renderer outputs a finished MP4 in one of two 3D templates.

## Templates

For each episode `<slug>` you get two compositions in the studio:

| Composition id          | File                  | Best for                                        |
| ----------------------- | --------------------- | ----------------------------------------------- |
| `<slug>-flow`           | `src/flow-slides.tsx` | Continuous side-scrolling row of covers over a still photo backdrop.          |
| `<slug>-bars`           | `src/bar-slides.tsx`  | Money / count / size comparisons — 3D pillars sized by value, indoor showroom. |

## Per-episode workflow

```console
# 1. Scaffold a new episode
npm run new-episode top-15-largest-diamonds-ever-found "TOP 15 LARGEST" "DIAMONDS EVER FOUND"

# 2. Hand-edit episodes/<slug>.json — fill in items[] with rank/title/value/imageSource

# 3. Fetch + normalize all cover images (and optional bg-removal / flag chips)
npm run build-episode top-15-largest-diamonds-ever-found

# 4. Render either template to MP4
npm run render top-15-largest-diamonds-ever-found-flow   # flow
npm run render top-15-largest-diamonds-ever-found-bars   # bar

# 5. (optional) Publish to YouTube as a private upload
npm run publish-episode top-15-largest-diamonds-ever-found-bars
```

## Episode JSON schema

```jsonc
{
  "slug": "top-15-largest-diamonds-ever-found",
  "title": ["TOP 15 LARGEST", "DIAMONDS EVER FOUND"],
  "outro": ["WHO SURPRISED YOU?", "Like & subscribe for more"],
  "unitLabel": "carats",
  "valueFormat": "raw",         // "compact" (default, treats value as millions) or "raw" (literal w/ commas)
  "coverFit": "contain",         // "inside" (default) or "contain" — pad to white square
  "removeBg": true,              // strip backgrounds from every cover before saving
  "audioPath": "audio/...mp3",   // optional background music path under /public
  "audioVolume": 0.35,           // 0..1, default 0.35
  "items": [
    {
      "rank": 1,
      "title": "Cullinan Diamond",
      "value": 3107,
      "country": "ZA",            // ISO 3166-1 alpha-2 — composites a flag chip
      "imageSource": "https://en.wikipedia.org/wiki/Special:FilePath/Cullinan_Diamond.jpg",
      "removeBg": false           // per-item override
    }
  ]
}
```

## Image tooling

| Command | Purpose |
| ------- | ------- |
| `npm run build-episode <slug>`  | Fetch + normalize every cover image, run optional bg-removal, composite optional country flag chips. Idempotent — skips items already on disk. |
| `npm run remove-bg -- <input> [output]` | Standalone bg removal via `@imgly/background-removal-node`. `--composite=white` (or `#hex`) flattens onto a square. |
| `npm run upscale -- <input> [output]`   | Real-ESRGAN 4K upscale. Requires the binary in `tools/realesrgan/` per the script's first-run instructions. |
| `npm run fetch-flags`                    | Download flag PNGs from flagcdn.com for every country code referenced by any episode. |

## YouTube publishing

`npm run publish-episode <slug>` uploads the rendered MP4 as private with auto-SEO metadata (chapter timestamps from item ranks, thumbnail upload, etc.). One-time auth: `npm run youtube-auth`.

## Project layout

```
episodes/         Episode JSONs (auto-indexed via episodes/index.ts)
public/
  audio/          Reusable background music
  bg.jpeg         Backdrop used by flow-slides
  covers/         Per-episode cover images (built by build-episode)
  flags/          Country flag PNGs (downloaded by fetch-flags)
scripts/          Build / render / publish CLI tools
src/
  bar-slides.tsx  3D pillar template
  flow-slides.tsx Side-scrolling row template
  episode.ts      Episode + EpisodeItem types
  Root.tsx        Registers compositions for every episode in episodes/
out/              Rendered MP4s (gitignored)
tools/            Real-ESRGAN binary lives here after one-time setup
```

## Idea tracker

See `ideas.md` for the curated list of ranked video ideas, organized by viral potential and matched to the best template.
