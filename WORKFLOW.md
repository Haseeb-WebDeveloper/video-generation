# Video Creation Workflow

The contract the agent follows when the user says **"create a video on X"** (or "make a video on X", "let's do a Top X about Y", etc.). The user runs the studio and the final render themselves — the agent's job ends when the covers look premium in `npm run dev` and the JSON is correct.

## The five-phase workflow

```
1. RESEARCH     → 2. ITEMS LIST    → 3. SOURCE & BUILD  → 4. PREVIEW GATE  → 5. HAND-OFF
   (agent)         (post in chat)     (agent)              (USER reviews)     (agent stops)
                   ↑ wait for "ok"                          ↑ wait for "render it"
```

The agent never starts a render. Rendering is always a user-initiated step after the user has previewed the covers in `npm run dev`.

---

## Phase 1 — Research

Before anything else, look up the topic:

- The canonical metric (e.g. "largest diamonds" → rough carats, not cut carats; "highest grossing" → inflation-adjusted vs unadjusted; "most followed" → as of what date).
- Whether good images exist on Wikipedia / Wikimedia Commons for _every_ candidate item. Many famous things have articles but no inline image — those will fail the build silently.
- The right item count. If only 8 items have usable images, ship "Top 8", not "Top 15 with 7 missing."

Don't skip this. The single biggest cause of bad covers is "the topic was researched after the items list was already locked."

## Phase 2 — Items list (REVIEW GATE)

Post the items list in chat as plain text, **before** writing any JSON or downloading anything:

```
Rank — Title — Value — Country (optional)
 1   — Foo                 — 12,345 — US
 2   — Bar                 — 11,000 — DE
 …
```

Wait for the user's `ok` (or edits). This is the only checkpoint where the user can cheaply redirect — once images are downloading, everyone has invested time.

If the user mentions a number ("Top 15") and only 8 candidates have good source images, propose a smaller-N title (e.g. "Top 8") rather than padding the list with low-quality entries. Better small + premium than long + janky.

## Phase 3 — Source images & build

Once the list is approved:

1. **Scaffold:** `npm run new-episode <slug>` (auto-registers in `episodes/index.ts`).
2. **Author the JSON** at `episodes/<slug>.json`. Schema in `README.md`. Per-episode flags worth knowing:
   - `valueFormat`: `"raw"` for literal numbers (carats, employees), `"compact"` for $ in millions.
   - `coverFit`: `"contain"` to pad each cover into a 1024×1024 white square — recommended whenever covers are mixed-aspect (logos, gemstones, products).
   - `removeBg`: `true` to strip backgrounds. **Default to `false`.** Bg removal is a sharp tool — it works well for solid products on busy backgrounds (watches, sneakers) and _worse_ for translucent / shiny / textured subjects (gemstones, glass, photographs). When in doubt, leave it off and hand-curate sources instead.
   - `compositeFlagOnCover`: `false` if you intend to render with the `bar` template (which already shows a separate flagpole). `true` (default) is correct for `flow`.
3. **Image-source quality bar (apply per item):**
   - Prefer Wikipedia originals (they tend to be 800–4000 px).
   - Request `?width=2048` not `?width=1200` when querying Wikipedia file paths — the build pipeline will downscale to 1024 anyway, but starting larger means the resize is cleaner.
   - If a source is below ~800 px on its long side, mark it for upscaling (`npm run upscale -- <input> <output>` after the build, then point `imagePath` at the upscaled file). Don't try to upscale low-res photographs of historical subjects — modern AI upscalers hallucinate detail and it reads as fake.
   - **Reject anything that looks bad on its own.** Bad sources don't get fixed by the templates. If three minutes of search hasn't found a clean image, propose dropping or replacing the item.
4. **Build:** `npm run build-episode <slug>`. The pipeline downloads each image, optionally bg-removes, optionally adds a flag chip, and writes `public/covers/<slug>/<rank>.jpg`. It is idempotent — re-runs only fetch missing items.
5. **Cover spot-check:** open every `public/covers/<slug>/*.jpg` and look at it. Specifically reject:
   - Low resolution that turned mushy after the resize (visible JPEG mosaic blocks).
   - Bg removal artifacts (halos around the subject, missing parts of the subject).
   - The wrong subject — Wikipedia's title-fallback can grab a generic redirect (e.g. "Brown diamond" instead of the named diamond).
   - Ugly framing — subject too small, off-center, cut off.
     For each rejected cover, edit the item's `imageSource` in JSON and re-run build.

## Phase 4 — Preview gate (USER step)

Hand back to the user with one line:

> Covers are built. Run `npm run dev` and the Remotion studio will show two compositions: `<slug>-flow` (flow) and `<slug>-bars` (bar). Pick the one that fits the topic best. Reply with which template to keep — or render it yourself when you're happy.

The user previews. They may ask for tweaks (different items, different sources, different template choice). Loop back to Phase 3.

## Phase 5 — Hand-off

When the user says they're happy / ready to render, the agent's role is to **say nothing and stop**. The user runs:

```bash
npm run render <slug>-flow      # flow
npm run render <slug>-bars      # bar
```

The renderer writes `out/<composition-id>.mp4`. Then `npm run publish-episode <slug>-<template>` for YouTube upload (separate workflow).

---

## Hard rules

- **Never auto-render.** Even after a successful build. Rendering is the user's call.
- **Never `removeBg: true` on the first build of an unknown topic.** Try without first — bg removal is a tool to reach for _after_ you've seen the source images and decided they need it.
- **Never lock the title before image sourcing.** Adjust N to match the number of items that have premium-looking source photos.
- **Never fill missing items with bad images.** A clean Top 8 beats a janky Top 15 every time.
- **Never use a generic placeholder image to fake a hit.** If the build's Wikipedia title-fallback returned a redirect (e.g. "Brown diamond" for "Incomparable Diamond"), drop the item rather than ship the wrong subject.
- **Never modify `episodes/index.ts` by hand.** It's regenerated by `new-episode.mjs` from the JSON files in `episodes/`.

## Quick reference

```bash
# Start a video
npm run new-episode <slug> "TOP X TITLE LINE 1" "TITLE LINE 2"

# Build covers (idempotent, skip-completed)
npm run build-episode <slug>

# Standalone tools (apply to specific items as needed)
npm run upscale  -- <input> [output]                         # 4K AI upscale
npm run remove-bg -- <input> [output] [--composite=white]    # bg removal
npm run fetch-flags                                          # download missing flag PNGs

# Preview (USER)
npm run dev

# Render (USER) — must include a template suffix
npm run render <slug>-bars     # or <slug>-flow

# Publish to YouTube (USER, after review)
npm run publish-episode <slug>-bars
```
