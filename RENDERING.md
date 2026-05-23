# Free cloud rendering & monthly batch workflow

Rendering happens on **GitHub Actions** (free), not your PC. Combined with the
30fps output and lighter render scene, this removes the render-time bottleneck.

## One-time setup
1. Push this repo to GitHub. **Make it public** for *unlimited* free Actions
   minutes (a private repo only gets 2,000 free min/month).
   - Safe to be public: no secrets are committed. `.env` is gitignored. The
     render workflow needs no secrets at all.
2. That's it — the workflow in `.github/workflows/render.yml` is ready.

## Rendering a video (or a batch) for free
1. On GitHub: **Actions → "Render videos" → Run workflow**.
2. Enter one or more episode slugs, comma-separated
   (e.g. `countries-tournament` or `worldcup-jan1,worldcup-jan2,...`).
3. Each slug renders on its **own parallel runner**. When done, download the
   MP4s from the run's **Artifacts**.

Notes:
- The bake is regenerated deterministically in CI from the committed
  `tournamentSeed` (`--keep`), so the cloud render matches what you saw locally.
- Runners have no GPU (software WebGL), but the CPU beats the laptop, it's
  parallel, and free. A ~3-min video fits comfortably in one job.
- For much longer videos (10–15 min), split each into frame-range chunks across
  jobs and concat — ask Claude to extend the workflow when you get there.
- If a render errors on WebGL, change `--gl=angle` to `--gl=swiftshader` in the
  workflow.

## One-time YouTube setup (needed for auto-publish — only you can do this)
1. Google Cloud Console → new project → enable **YouTube Data API v3**.
2. Create an **OAuth client ID** (type: Desktop) → copy the Client ID + Secret.
3. Locally, put them in `.env`:
   ```
   YOUTUBE_CLIENT_ID=...
   YOUTUBE_CLIENT_SECRET=...
   ```
   then run `npm run youtube-auth` and follow the prompt to authorize. It prints
   a `YOUTUBE_REFRESH_TOKEN` — add it to `.env` too.
4. In GitHub → repo **Settings → Secrets and variables → Actions**, add three
   secrets: `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`.

Quota note: each upload costs 1,600 of the default 10,000/day quota (~6/day).
Spread a 10-video batch over 2 days, or request a quota increase.

## The monthly production loop (≈1 hour of work / month)
1. **Create 10 episodes** locally (different country sets). Each is an
   `episodes/<slug>.json` with `items` (40 countries). Lock a good seed +
   auto-generate SEO + bake:
   `npm run tournament-roll <slug> --seed=N` (eyeball the winner/drama; it also
   writes a `youtube` title/description/tags block if one isn't already there).
2. **Schedule the batch** — stamp each episode's release 3 days apart:
   `npm run schedule-batch -- --start=2026-06-02T17:00:00Z --every=3 slug1 slug2 ...`
3. **Commit & push** to GitHub.
4. **Run the "Render videos" workflow** with all slugs and **publish = true**.
   Each video renders in parallel (free), then uploads to YouTube as *private*
   with its `publishAt` set — **YouTube auto-releases one every 3 days**. Fully
   hands-off after this click.

Render-only (no upload): run the workflow with **publish = false** and download
the MP4s from the run's Artifacts.
