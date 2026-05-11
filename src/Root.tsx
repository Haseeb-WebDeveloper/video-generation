import "./index.css";
import { Composition } from "remotion";
import { episodes } from "../episodes";
import {
  FlowSlidesComposition,
  totalFrames as flowTotalFrames,
} from "./flow-slides";
import {
  BarSlidesComposition,
  totalFrames as barTotalFrames,
} from "./bar-slides";
import type { Episode } from "./episode";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {episodes.map((ep) => (
        <Composition
          key={`${ep.slug}-flow`}
          id={`${ep.slug}-flow`}
          component={FlowSlidesComposition}
          durationInFrames={flowTotalFrames(ep.items)}
          fps={60}
          width={1920}
          height={1080}
          defaultProps={{ episode: ep }}
          calculateMetadata={({ props }: { props: { episode: Episode } }) => ({
            durationInFrames: flowTotalFrames(props.episode.items),
          })}
        />
      ))}
      {episodes.map((ep) => (
        <Composition
          key={`${ep.slug}-bars`}
          id={`${ep.slug}-bars`}
          component={BarSlidesComposition}
          durationInFrames={barTotalFrames(ep.items)}
          fps={60}
          width={1920}
          height={1080}
          defaultProps={{ episode: ep }}
          calculateMetadata={({ props }: { props: { episode: Episode } }) => ({
            durationInFrames: barTotalFrames(props.episode.items),
          })}
        />
      ))}
    </>
  );
};
