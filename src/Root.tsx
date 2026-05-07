import "./index.css";
import { Composition } from "remotion";
import { episodes } from "../episodes";
import {
  SkySlidesComposition,
  totalFrames as skyTotalFrames,
} from "./sky-slides";
import {
  FlowSlidesComposition,
  totalFrames as flowTotalFrames,
} from "./flow-slides";
import type { Episode } from "./episode";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {episodes.map((ep) => (
        <Composition
          key={ep.slug}
          id={ep.slug}
          component={SkySlidesComposition}
          durationInFrames={skyTotalFrames(ep.items)}
          fps={60}
          width={1920}
          height={1080}
          defaultProps={{ episode: ep }}
          calculateMetadata={({ props }: { props: { episode: Episode } }) => ({
            durationInFrames: skyTotalFrames(props.episode.items),
          })}
        />
      ))}
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
    </>
  );
};
