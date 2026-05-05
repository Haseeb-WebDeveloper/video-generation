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
  youtube?: EpisodeYouTube;
};
