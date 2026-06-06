# AI Voiceover

Narration is the single biggest retention lever for these ranking videos. The
pipeline generates a timed voiceover track that lines up with the flow
template's countdown and muxes it over a ducked music bed at render time.

## Engines

| Engine | Cost | Key | Quality |
| ------ | ---- | --- | ------- |
| **edge** (default) | **FREE, unlimited** | none | Microsoft Edge neural voices — Azure-grade, very natural |
| eleven | paid credits | `ELEVENLABS_API_KEY` | ElevenLabs premium voices |

**Default is free Microsoft Edge TTS** (`msedge-tts`) — no API key, no per-character
credits, none of ElevenLabs' "Unusual activity detected" IP blocks. Use ElevenLabs
(`--engine=eleven`) only when you want a premium voice and have credits.

## One-time setup
Nothing required for the free engine. Optional `.env` overrides:
```
EDGE_VOICE_ID=en-US-AndrewNeural   # default narrator (free engine)
VOICEOVER_ENGINE=edge              # or "eleven"
# only if using ElevenLabs:
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_VOICE_ID=...
```

### Free narrator voices (Edge, en-US)
Male: `en-US-AndrewNeural` (default, warm documentary), `en-US-BrianNeural`,
`en-US-GuyNeural`, `en-US-ChristopherNeural`, `en-US-EricNeural`.
Female: `en-US-EmmaNeural`, `en-US-AvaNeural`, `en-US-AriaNeural`, `en-US-JennyNeural`.
Pick per video with `--voice=en-US-BrianNeural`.

## Per-episode workflow
```bash
# 1. (optional) Hand-write punchy lines — cliffhangers, comparisons, the #1 tease.
#    episodes/voiceover/<slug>.script.json   (keyed by rank; omitted lines auto-fill)

# 2. Preview the full script + cue times (free, generates nothing):
npm run voiceover <slug> -- --dry-run

# 3. Generate the audio clips (FREE Edge TTS by default):
npm run voiceover <slug>
#    premium:  npm run voiceover <slug> -- --engine=eleven
#    voice:    npm run voiceover <slug> -- --voice=en-US-BrianNeural

# 4. Render — the mux auto-detects the manifest and lays narration over ducked music:
npm run render <slug>-flow
```

## How it works
- `scripts/lib/voiceover-timing.mjs` computes when each line should play, mirroring
  the flow template's pacing (intro hold → ~5s per card, counting DOWN to #1 → outro).
  **If you change pacing constants in `src/flow-slides.tsx`, mirror them here.**
- `scripts/generate-voiceover.mjs` resolves each line (hand-written wins, else a
  template), calls the chosen TTS engine (free Edge by default), and writes one mp3
  per line + a `manifest.json` mapping clip → start time.
- `scripts/render-episode.mjs` reads the manifest and builds an ffmpeg filtergraph:
  each clip is delayed to its cue (`adelay`), the music bed is dropped to a low
  fixed volume (≤0.10) and summed in (`amix`). No sidechain ducking (the bundled
  ffmpeg lacks it) — the constant low bed is predictable and clean under speech.

## Script-writing tips (this is where retention is won)
- **Hook (0.5s):** open with the most shocking fact or a pattern-break ("It's not
  America — America isn't even in the top fifteen"). This is the make-or-break line.
- **Item lines:** keep to ONE short sentence (~2–4s) so they fit the ~5s card window.
- **Cliffhangers on the last few:** "but the top three are on another level…".
- **#1:** a beat of suspense, then the reveal + the number.
- **Outro:** a question to drive comments + subscribe CTA.

See `episodes/voiceover/most-obese-countries.script.json` for a worked example.
