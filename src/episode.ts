export type EpisodeItem = {
  rank: number;
  title: string;
  value: number;
  imageSource?: string;
  imagePath?: string;
};

export type Episode = {
  slug: string;
  title: [string, string];
  outro: [string, string];
  unitLabel: string;
  items: EpisodeItem[];
};
