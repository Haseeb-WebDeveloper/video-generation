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
import {
  RaceSlidesComposition,
  totalFrames as raceTotalFrames,
} from "./race-slides";
import {
  TopBattleSlidesComposition,
  totalFrames as battleTotalFrames,
} from "./top-battle-slides";
import {
  TournamentComposition,
  tournamentTotalFrames,
} from "./tournament-slides";
import { BarThumbnailComposition } from "./thumbnail-bar";
import type { Episode } from "./episode";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {episodes
        .filter((ep) => ep.template === "flow" || !ep.template)
        .map((ep) => (
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
      {episodes
        .filter((ep) => ep.template === "bars" || !ep.template)
        .map((ep) => (
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
      {/* Race template — registered only when a bake exists (raceResult +
          raceBakePath both set). The composition stays out of the studio's
          list until you've run `npm run race-roll <slug>`, so non-race
          episodes don't carry an empty placeholder. */}
      {episodes
        .filter(
          (ep) =>
            (ep.template === "race" || !ep.template) &&
            !!ep.raceResult &&
            !!ep.raceBakePath,
        )
        .map((ep) => (
          <Composition
            key={`${ep.slug}-race`}
            id={`${ep.slug}-race`}
            component={RaceSlidesComposition}
            durationInFrames={raceTotalFrames(ep)}
            fps={60}
            width={1920}
            height={1080}
            defaultProps={{ episode: ep }}
            calculateMetadata={({ props }: { props: { episode: Episode } }) => ({
              durationInFrames: raceTotalFrames(props.episode),
            })}
          />
        ))}
      {/* Top-battle template — registered only when a battle bake exists
          (battleResult + battleBakePath both set). Same gating pattern as
          race above so non-battle episodes don't show an empty entry. */}
      {episodes
        .filter(
          (ep) =>
            (ep.template === "battle" || !ep.template) &&
            !!ep.battleResult &&
            !!ep.battleBakePath,
        )
        .map((ep) => (
          <Composition
            key={`${ep.slug}-battle`}
            id={`${ep.slug}-battle`}
            component={TopBattleSlidesComposition}
            durationInFrames={battleTotalFrames(ep)}
            fps={30}
            width={1920}
            height={1080}
            defaultProps={{ episode: ep }}
            calculateMetadata={({ props }: { props: { episode: Episode } }) => ({
              durationInFrames: battleTotalFrames(props.episode),
            })}
          />
        ))}
      {/* Tournament template — bracket of battles. Registered only when a
          tournamentResult exists (run `npm run tournament-roll <slug>`). */}
      {episodes
        .filter(
          (ep) =>
            (ep.template === "tournament" || !ep.template) &&
            !!ep.tournamentResult,
        )
        .map((ep) => (
          <Composition
            key={`${ep.slug}-tournament`}
            id={`${ep.slug}-tournament`}
            component={TournamentComposition}
            durationInFrames={tournamentTotalFrames(ep)}
            fps={30}
            width={1920}
            height={1080}
            defaultProps={{ episode: ep }}
            calculateMetadata={({ props }: { props: { episode: Episode } }) => ({
              durationInFrames: tournamentTotalFrames(props.episode),
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
      {episodes
        .filter((ep) => ep.template === "bars" || !ep.template)
        .map((ep) => (
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
