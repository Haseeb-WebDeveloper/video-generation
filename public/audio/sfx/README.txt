Drop battle sound effects here, then tell Claude to enable SFX
(flip SFX_ENABLED = true in src/top-battle-slides.tsx).

Expected files (short, normalized, mp3):
  hit.mp3   - top-on-top clash: a short, punchy clink/clack (~150-400ms).
              Played once per (throttled) top collision, volume scales with hit strength.
  wall.mp3  - top hits the wall: a short, duller thud (~150-400ms).
  whir.mp3  - spinning ambience bed: a smooth, loopable whirring/humming
              (1-3s, seamless loop). Plays quietly through each battle.

Tips:
- Keep them short and loud-normalized; the code sets the mix volume.
- Mono is fine. 44.1kHz mp3.
- Good free sources: freesound.org, pixabay.com/sound-effects (check license).
