import "./index.css";
import { Composition } from "remotion";
import { episodes } from "../episodes";
import { SkySlidesComposition, totalFrames } from "./sky-slides";
import type { Episode } from "./episode";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {episodes.map((ep) => (
        <Composition
          key={ep.slug}
          id={ep.slug}
          component={SkySlidesComposition}
          durationInFrames={totalFrames(ep.items)}
          fps={60}
          width={1920}
          height={1080}
          defaultProps={{ episode: ep }}
          calculateMetadata={({ props }: { props: { episode: Episode } }) => ({
            durationInFrames: totalFrames(props.episode.items),
          })}
        />
      ))}
    </>
  );
};
