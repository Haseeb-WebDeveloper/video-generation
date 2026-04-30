export type Game = {
  rank: number;
  title: string;
  year: number;
  publisher: string;
  copiesMillions: number;
  color: string;
};

export const games: Game[] = [
  { rank: 1, title: "Minecraft", year: 2011, publisher: "Mojang", copiesMillions: 300, color: "#5d8a3a" },
  { rank: 2, title: "Grand Theft Auto V", year: 2013, publisher: "Rockstar Games", copiesMillions: 210, color: "#f6b042" },
  { rank: 3, title: "Tetris (EA)", year: 2006, publisher: "Electronic Arts", copiesMillions: 100, color: "#ff5577" },
  { rank: 4, title: "Wii Sports", year: 2006, publisher: "Nintendo", copiesMillions: 82.9, color: "#e8e8e8" },
  { rank: 5, title: "PUBG: Battlegrounds", year: 2017, publisher: "Krafton", copiesMillions: 75, color: "#d4a015" },
  { rank: 6, title: "Mario Kart 8 / Deluxe", year: 2014, publisher: "Nintendo", copiesMillions: 75, color: "#e63946" },
  { rank: 7, title: "Red Dead Redemption 2", year: 2018, publisher: "Rockstar Games", copiesMillions: 70, color: "#8b1a1a" },
  { rank: 8, title: "The Elder Scrolls V: Skyrim", year: 2011, publisher: "Bethesda", copiesMillions: 60, color: "#6b8e9c" },
  { rank: 9, title: "Terraria", year: 2011, publisher: "Re-Logic", copiesMillions: 58.7, color: "#7fc97f" },
  { rank: 10, title: "Super Mario Bros.", year: 1985, publisher: "Nintendo", copiesMillions: 58, color: "#d62828" },
  { rank: 11, title: "The Witcher 3: Wild Hunt", year: 2015, publisher: "CD Projekt", copiesMillions: 55, color: "#c4422a" },
  { rank: 12, title: "Pokémon Red / Blue / Yellow", year: 1996, publisher: "Nintendo", copiesMillions: 47.5, color: "#ffcb05" },
  { rank: 13, title: "Animal Crossing: New Horizons", year: 2020, publisher: "Nintendo", copiesMillions: 47, color: "#7ed4a3" },
  { rank: 14, title: "Wii Fit / Plus", year: 2007, publisher: "Nintendo", copiesMillions: 43, color: "#90c8e0" },
  { rank: 15, title: "Human: Fall Flat", year: 2016, publisher: "Curve Games", copiesMillions: 40, color: "#f4a261" },
  { rank: 16, title: "Mario Kart Wii", year: 2008, publisher: "Nintendo", copiesMillions: 37.4, color: "#ef476f" },
  { rank: 17, title: "Hogwarts Legacy", year: 2023, publisher: "WB Games", copiesMillions: 30, color: "#9b5de5" },
  { rank: 18, title: "Diablo III", year: 2012, publisher: "Blizzard", copiesMillions: 30, color: "#a52a2a" },
  { rank: 19, title: "Call of Duty: Modern Warfare (2019)", year: 2019, publisher: "Activision", copiesMillions: 30, color: "#4a4e4d" },
  { rank: 20, title: "New Super Mario Bros. (DS)", year: 2006, publisher: "Nintendo", copiesMillions: 30, color: "#e76f51" },
];
