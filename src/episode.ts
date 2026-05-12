export type EpisodeItem = {
  rank: number;
  title: string;
  value: number;
  imageSource?: string;
  imagePath?: string;
  // ISO 3166-1 alpha-2 country code (e.g. "US", "CN", "DE"). When set, a
  // small flag chip is composited into the cover image at build time.
  country?: string;
  // Per-item override for the episode-level `removeBg` flag. Use this when
  // most items in an episode share one preference but a few need the
  // opposite (e.g. one item already ships with a clean background).
  removeBg?: boolean;
};

// title, description, and tags are REQUIRED at publish time. Type stays
// optional so the studio can load episodes that haven't had SEO authored yet,
// but `npm run publish-episode <slug>` refuses to upload until they are set.
// description supports a literal `{{chapters}}` token, replaced at publish
// time with the auto-computed chapter timestamp block.
export type EpisodeYouTube = {
  title?: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  privacyStatus?: "private" | "unlisted" | "public";
  madeForKids?: boolean;
  publishAt?: string;
  defaultLanguage?: string;
  playlistId?: string;
};

export type Episode = {
  slug: string;
  title: [string, string];
  outro: [string, string];
  unitLabel: string;
  items: EpisodeItem[];
  // Optional background music. Path is relative to /public, e.g. "audio/foo.mp3".
  audioPath?: string;
  // 0 to 1. Defaults to 0.35 if omitted.
  audioVolume?: number;
  // "compact" (default): value treated as millions, displayed as "2.1M" / "14.0B".
  // "raw": value is the literal count, displayed with thousands separators ("2,100,000").
  valueFormat?: "compact" | "raw";
  // "inside" (default): preserve cover aspect ratio (existing behavior — wide
  // photos stay wide, tall photos stay tall).
  // "contain": pad each cover to a 1024×1024 square with white background so
  // mixed-aspect logos render at consistent card size in the 3D scene.
  // "cover": center-crop each cover to a uniform 3:2 aspect ratio. Used for
  // country flags (most are 3:2 native; outliers like Switzerland 1:1 lose
  // a thin strip but the central motif still reads). Produces a clean row
  // of same-shaped cards without the white padding of "contain".
  coverFit?: "inside" | "contain" | "cover";
  // When true, the build pipeline strips the background from every cover
  // image and composites it onto a white square. Best for episodes where
  // the subject is a discrete object (a watch, a diamond, a sneaker) and
  // source photos arrive with messy / inconsistent backgrounds.
  // Per-item override available on `EpisodeItem.removeBg`.
  removeBg?: boolean;
  // Defaults to true. When false, the build pipeline does NOT bake a country
  // flag chip into the cover JPG — useful when the chosen template renders
  // its own flag (e.g. the bar template's flagpole) and a chip on the cover
  // would be redundant or visually noisy.
  compositeFlagOnCover?: boolean;
  // Bar-template-only knob. When true, each pillar renders a single LARGE
  // centered flag on a pole rising from its top — no cover card, no small
  // corner flag. Used for flag-themed ranking episodes (e.g. "countries by
  // X") where the flag IS the visual and a separate cover image is
  // redundant. Falls back to the standard cover-card layout when false or
  // unset.
  flagHero?: boolean;
  // YouTube thumbnail. Path is relative to /public, e.g.
  // "thumbnails/top-25-best-foo.jpg". This image is the master — typically a
  // 4K upscale produced via `npm run upscale`. publish-episode resizes and
  // recompresses it to fit YouTube's 2MB / 1280×720+ spec before uploading
  // via the thumbnails.set API after the video upload completes.
  thumbnailPath?: string;
  // Optional override for which item gets heroed in the auto-generated
  // thumbnail (via the `<slug>-flow-thumb` Remotion still composition).
  // Defaults to 1 (the #1-ranked item). Useful when #1's cover doesn't
  // make a compelling blurred mystery (e.g. an instantly-recognizable
  // national flag) and a lower-rank item creates a better tease.
  thumbnailHeroRank?: number;
  // Optional URL to download into thumbnailPath at build-episode time. If
  // both are set, an existing local thumbnailPath wins (no re-download).
  thumbnailSource?: string;
  youtube?: EpisodeYouTube;
};
