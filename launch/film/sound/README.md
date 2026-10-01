# AI Bro product-film score

`render_score.py` creates the original 42-second stereo instrumental used by the
product film. It uses mathematical oscillators and seeded, filtered noise: no
recordings, downloaded samples, speech, third-party compositions, network
services, or personal data. Source and generated output follow this repository's
license.

The arrangement pairs bright D-major/add-nine key tones with a restrained
**120 BPM half-time groove**. Rounded low percussion, short wooden taps, and soft
brush textures support the product cuts without sharp electronic bleeps. The
opening title and the final value cards are sparser. The last brand chord at
39 seconds resolves into a two-second fade to silence.

Tactile accents follow the film's edit points at 0, 0.6, 1.8, 3.4, 5, 6.5, 8.5,
10.5, 12, 14.2, 17, 20, 22.2, 25, 26.6, 29, 31.5, 34, 36, 36.7, 37.4, and
39 seconds. Low-level noise sweeps precede the major chapter changes. There is
no spoken narration.

## Rebuild

From the repository root, with Python 3, numpy, and FFmpeg available:

```sh
python3 launch/film/sound/render_score.py
```

The default output is `launch/dist/assets/film/score.wav`: exactly 42.000 seconds,
48 kHz, stereo, signed 16-bit PCM. An alternative path can be passed with
`--output`, and a non-default FFmpeg executable with `--ffmpeg`. The fixed seed
makes oscillator phases and noise reproducible. The renderer measures the
synthesized signal with EBU R128, applies a constant gain to target −19 LUFS while
preserving a −2.4 dB true-peak ceiling, and measures the quantized final signal.
There is no hard limiting or dynamic compression.

`score-report.json` records the output hash, edit cues, and numerical checks.
For bit-for-bit reproduction, use the same numpy and FFmpeg versions; FFmpeg's
loudness measurement can vary slightly between versions.

## Verification and mixing

The delivered file was checked with numpy and FFmpeg's EBU R128 analysis:

- Integrated loudness: **−19.0 LUFS**.
- True peak: **−4.6 dBFS**; **zero clipped samples**.
- Loudness range: **2.4 LU**.
- First and last frames: digital silence in both channels.
- Duration: **42.000 seconds**; stereo correlation: **0.9522**.
- A second render produced the identical SHA-256 output hash.

These are signal-integrity checks, not human-listening acceptance. There was no
audio-listening tool in the generation environment. The intended film mix uses
unity gain; a 0.7 multiplier makes the score approximately 3.1 dB quieter. The
website must not automatically start audible playback: the viewer chooses to
play the film.

Recheck loudness after regeneration:

```sh
ffmpeg -hide_banner -i launch/dist/assets/film/score.wav \
  -af ebur128=peak=true -f null -
```
