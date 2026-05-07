// Auto-maintained by scripts/new-episode.mjs. Safe to hand-edit.
import type { Episode } from "../src/episode";
import top10HighestGrossingMovies from "./top-10-highest-grossing-movies.json";
import top25HighestGrossingMovies from "./top-25-highest-grossing-movies.json";
import top20BestSellingVideoGames from "./top-20-best-selling-video-games.json";
import top20MostExpensivePaintings from "./top-20-most-expensive-paintings.json";

export const episodes: Episode[] = [
  top10HighestGrossingMovies as Episode,
  top25HighestGrossingMovies as Episode,
  top20BestSellingVideoGames as Episode,
  top20MostExpensivePaintings as Episode,
];
