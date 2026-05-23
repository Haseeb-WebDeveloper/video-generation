// Auto-maintained by scripts/new-episode.mjs. Safe to hand-edit.
import type { Episode } from "../src/episode";
import top15LargestDiamondsEverFound from "./top-15-largest-diamonds-ever-found.json";
import top15MostDangerousAnimals from "./top-15-most-dangerous-animals.json";
import top15MostExpensiveLiquids from "./top-15-most-expensive-liquids.json";
import top20CountriesWithMostBillionaires from "./top-20-countries-with-most-billionaires.json";
import top20LargestBlackHolesDiscovered from "./top-20-largest-black-holes-discovered.json";
import top15MostExpensiveSneakersEverSold from "./top-15-most-expensive-sneakers-ever-sold.json";
import top20MostExpensiveCelebrityDivorces from "./top-20-most-expensive-celebrity-divorces.json";
import religionOfEveryCountry from "./religion-of-every-country.json";
import countriesMarbleRace from "./countries-marble-race.json";
import countriesTopBattle from "./countries-top-battle.json";
import countriesTournament from "./countries-tournament.json";
import europeCup from "./europe-cup.json";
import asiaCup from "./asia-cup.json";
import africaCup from "./africa-cup.json";
import americasCup from "./americas-cup.json";
import islandNations from "./island-nations.json";
import mostPopulous from "./most-populous.json";
import topEconomies from "./top-economies.json";
import footballGiants from "./football-giants.json";
import worldPowers from "./world-powers.json";
import flagsOfTheWorld from "./flags-of-the-world.json";

export const episodes: Episode[] = [
  top15LargestDiamondsEverFound as Episode,
  top15MostDangerousAnimals as Episode,
  top15MostExpensiveLiquids as Episode,
  top20CountriesWithMostBillionaires as Episode,
  top20LargestBlackHolesDiscovered as Episode,
  top15MostExpensiveSneakersEverSold as unknown as Episode,
  top20MostExpensiveCelebrityDivorces as Episode,
  religionOfEveryCountry as Episode,
  countriesMarbleRace as unknown as Episode,
  countriesTopBattle as unknown as Episode,
  countriesTournament as unknown as Episode,
  europeCup as unknown as Episode,
  asiaCup as unknown as Episode,
  africaCup as unknown as Episode,
  americasCup as unknown as Episode,
  islandNations as unknown as Episode,
  mostPopulous as unknown as Episode,
  topEconomies as unknown as Episode,
  footballGiants as unknown as Episode,
  worldPowers as unknown as Episode,
  flagsOfTheWorld as unknown as Episode,
];
