import "./index.css";
import { Composition } from "remotion";
import { MyComposition, TOTAL_FRAMES } from "./Composition";

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
    </>
  );
};
