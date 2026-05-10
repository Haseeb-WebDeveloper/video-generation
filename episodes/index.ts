// Auto-maintained by scripts/new-episode.mjs. Safe to hand-edit.
import type { Episode } from "../src/episode";
import top10HighestGrossingMovies from "./top-10-highest-grossing-movies.json";
import top20BestSellingVideoGames from "./top-20-best-selling-video-games.json";
import top20LargestCompaniesByEmployeeCount from "./top-20-largest-companies-by-employee-count.json";
import top20MostExpensivePaintings from "./top-20-most-expensive-paintings.json";
import top20MostExpensiveWatches from "./top-20-most-expensive-watches.json";
import top25HighestGrossingMovies from "./top-25-highest-grossing-movies.json";
import top25MostWatchedYoutubeVideos from "./top-25-most-watched-youtube-videos.json";

export const episodes: Episode[] = [
  top10HighestGrossingMovies as Episode,
  top20BestSellingVideoGames as Episode,
  top20LargestCompaniesByEmployeeCount as Episode,
  top20MostExpensivePaintings as Episode,
  top20MostExpensiveWatches as Episode,
  top25HighestGrossingMovies as Episode,
  top25MostWatchedYoutubeVideos as Episode,
];
