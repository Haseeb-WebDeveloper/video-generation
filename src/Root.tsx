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
import { BarThumbnailComposition } from "./thumbnail-bar";
import type { Episode } from "./episode";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {episodes.map((ep) => (
        <Composition
          key={`${ep.slug}-flow`}
          id={`${ep.slug}-flow`}
          component={FlowSlidesComposition}
          durationInFrames={flowTotalFrames(ep)}
          fps={60}
          width={1920}
          height={1080}
          defaultProps={{ episode: ep }}
          calculateMetadata={({ props }: { props: { episode: Episode } }) => ({
            durationInFrames: flowTotalFrames(props.episode),
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
      {/* Thumbnail still for the bar template — one frame per episode at
          2560×1440 (16:9, ~4K). Composes the top 5 pillars on the same
          backdrop the video uses, shot at a 3/4-perspective camera that
          fits all 5 in frame. Render via:
            npx remotion still <slug>-bars-thumb out/thumbnails/<slug>.png
          Then copy into public/thumbnails/ and set "thumbnailPath" on the
          episode JSON for publish-episode to pick up. */}
      {episodes.map((ep) => (
        <Composition
          key={`${ep.slug}-bars-thumb`}
          id={`${ep.slug}-bars-thumb`}
          component={BarThumbnailComposition}
          durationInFrames={1}
          fps={60}
          width={2560}
          height={1440}
          defaultProps={{ episode: ep }}
        />
      ))}
    </>
  );
};
