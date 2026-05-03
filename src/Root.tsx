import "./index.css";
import { Composition } from "remotion";
import { MyComposition, TOTAL_FRAMES } from "./Composition";
import {
  BeakersComposition,
  TOTAL_FRAMES as BEAKER_FRAMES,
} from "./Beakers";
import {
  SpaceComposition,
  TOTAL_FRAMES as SPACE_FRAMES,
} from "./Space";
import {
  BillboardsComposition,
  TOTAL_FRAMES as BB_FRAMES,
} from "./Billboards";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="TopGames"
        component={MyComposition}
        durationInFrames={TOTAL_FRAMES}
        fps={60}
        width={1920}
        height={1080}
      />
      <Composition
        id="TopGamesBeakers"
        component={BeakersComposition}
        durationInFrames={BEAKER_FRAMES}
        fps={60}
        width={1920}
        height={1080}
      />
      <Composition
        id="TopGamesSpace"
        component={SpaceComposition}
        durationInFrames={SPACE_FRAMES}
        fps={60}
        width={1920}
        height={1080}
      />
      <Composition
        id="TopGamesBillboards"
        component={BillboardsComposition}
        durationInFrames={BB_FRAMES}
        fps={60}
        width={1920}
        height={1080}
      />
    </>
  );
};
