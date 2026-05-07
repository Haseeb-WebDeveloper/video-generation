export type EpisodeItem = {
  rank: number;
  title: string;
  value: number;
  imageSource?: string;
  imagePath?: string;
};

export type EpisodeYouTube = {
  title?: string;
  description?: string;
  tags?: string[];
  extraTags?: string[];
  hashtags?: string[];
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
  youtube?: EpisodeYouTube;
};
