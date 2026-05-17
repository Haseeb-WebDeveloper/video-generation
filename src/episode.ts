export type EpisodeItem = {
  rank?: number;
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
  // Flow-template-only. When set, this text is rendered in white right
  // before the value on the same accent line. Used when each item has its
  // own per-item subtitle that should sit beside the number rather than
  // taking a third line (e.g. "Country" in the title, "Religion 96%" on
  // the value line). The value+unitLabel render in the accent color as
  // usual; only the prefix is white.
  unitPrefix?: string;
};

// One "scale primer" card rendered before the ranking, only by the flow
// template. Used to establish a visual baseline so the audience understands
// the magnitudes about to be revealed. For example, a "largest black holes by
// solar mass" episode might show: Sun (1 solar mass) → Milky Way (100 billion
// stars) → a teaser of #1's scale. The bar template ignores this field.
export type EpisodeIntroCard = {
  // Local image path under /public after the build pipeline downloads it,
  // e.g. "intro/top-20-foo/1.jpg". Set automatically by build-episode when
  // `imageSource` is present, but can also be pre-populated by hand.
  image?: string;
  // URL to download for this card. If both `image` and `imageSource` are set,
  // a pre-existing local file wins (the URL is not re-downloaded).
  imageSource?: string;
  // Top text on the card label — typically a short name like "OUR SUN".
  // When `caption` is omitted, the label renders vertically centered as a
  // single block so a one-liner like "OUR SUN = 1 SOLAR MASS" reads cleanly.
  label: string;
  // Bottom text — typically a comparison value like "1 solar mass" or a hook
  // like "but #1 is 100 BILLION times this". Optional; omit for a one-liner.
  caption?: string;
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
  // When true, no space is inserted between the formatted value and the
  // unitLabel — useful for "%" where "96 %" reads as two tokens but "96%"
  // is one. Defaults to false (existing space behavior preserved).
  valueNoSpace?: boolean;
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
  // Flow-template-only. Optional sequence of "scale primer" cards rendered
  // BEFORE the title board, so the audience sees a visual size baseline
  // before the countdown starts. See EpisodeIntroCard. Ignored by the bar
  // template.
  intro?: EpisodeIntroCard[];
  // Flow-template-only. When false, the title board (the "TOP 20 …" text
  // panel between intro and ranking) is hidden, and its segment is removed
  // from the camera pan so the camera doesn't pause on empty space. Useful
  // when intro cards already establish the topic and a separate banner
  // would feel redundant. Defaults to true.
  showTitleBoard?: boolean;
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

  // ─── Race template ─────────────────────────────────────────────
  // The race template is PURELY physics-driven — finish order is whatever
  // Rapier produces. The `items` rank field is meaningless for this
  // template; items are just the participant pool. To keep renders
  // deterministic across machines (and so the YouTube thumbnail/title can
  // pre-commit to a winner), we bake the simulation once via
  // `npm run race-roll <slug>` and store the seed + the resulting
  // trajectory ID + finish/elimination timeline back into the JSON.
  raceSeed?: number;
  // Filled by race-roll. Indices reference items[]; frames are 60fps.
  raceResult?: {
    // Order in which balls crossed the finish line. First entry = winner.
    finishOrder: number[];
    // Absolute frame number (from race start) when each finisher crossed.
    // Same length as finishOrder.
    finishFrames: number[];
    // Items that fell off the track and never finished. Frame is when they
    // were considered eliminated (left bounds / hit kill plane).
    eliminations: Array<{ index: number; frame: number }>;
    // Total race body length in frames (countdown excluded), so the
    // template doesn't have to recompute from finishFrames.
    raceFrames: number;
  };
  // Pointer to the baked per-frame transforms. Path is relative to /public,
  // e.g. "race-bakes/<slug>.bin". Populated by race-roll.
  raceBakePath?: string;
  // Visual preset. "neon" by default.
  raceTrackStyle?: "neon" | "sand" | "ice";
  // For now only "ball" is implemented. Reserved so we can add cars/skaters
  // later without a schema migration.
  raceObject?: "ball";
};
