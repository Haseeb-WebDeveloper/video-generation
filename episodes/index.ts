// Auto-maintained by scripts/new-episode.mjs. Safe to hand-edit.
import type { Episode } from "../src/episode";
import mostNuclearWeapons from "./most-nuclear-weapons.json";
import highestMilitarySpending from "./highest-military-spending.json";
import mostGunsPerPerson from "./most-guns-per-person.json";
import mostPrisonersPerCapita from "./most-prisoners-per-capita.json";
import highestNationalDebt from "./highest-national-debt.json";
import mostGoldReserves from "./most-gold-reserves.json";
import mostForeignReserves from "./most-foreign-reserves.json";
import mostRemittances from "./most-remittances.json";
import mostVisitedCountries from "./most-visited-countries.json";
import mostOilReserves from "./most-oil-reserves.json";

export const episodes: Episode[] = [
  mostNuclearWeapons as unknown as Episode,
  highestMilitarySpending as unknown as Episode,
  mostGunsPerPerson as unknown as Episode,
  mostPrisonersPerCapita as unknown as Episode,
  highestNationalDebt as unknown as Episode,
  mostGoldReserves as unknown as Episode,
  mostForeignReserves as unknown as Episode,
  mostRemittances as unknown as Episode,
  mostVisitedCountries as unknown as Episode,
  mostOilReserves as unknown as Episode,
];
