// Auto-maintained by scripts/new-episode.mjs. Safe to hand-edit.
import type { Episode } from "../src/episode";
import top15LargestDiamondsEverFound from "./top-15-largest-diamonds-ever-found.json";
import top15MostDangerousAnimals from "./top-15-most-dangerous-animals.json";
import top15MostExpensiveLiquids from "./top-15-most-expensive-liquids.json";
import top20CountriesWithMostBillionaires from "./top-20-countries-with-most-billionaires.json";

export const episodes: Episode[] = [
  top15LargestDiamondsEverFound as Episode,
  top15MostDangerousAnimals as Episode,
  top15MostExpensiveLiquids as Episode,
  top20CountriesWithMostBillionaires as Episode,
];
