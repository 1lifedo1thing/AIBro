# AI Bro — product film

An original **42-second, 1920 × 1080, 30 fps** product film authored in React and Remotion. It combines kinetic typography, layered real App captures, perspective, focal camera movement, a warm-white and mint palette, and an original synthesized instrumental score. Chinese and English are separate rendered editions.

This is a promotional composition. Its App images come from the isolated fictional AI Bro 0.8.0 workspace documented in `../README.md`. Camera crops and animation do not alter the captured UI or imply a live model run. The three screenshot-sequence demonstrations below the film remain separate workflow examples.

## Rebuild

Use Node.js 24 or later and a supported Chromium browser:

```sh
cd launch/film
npm ci
npm run render
```

By default Remotion uses its supported rendering browser. To use an existing browser installation, set `AIBRO_RENDER_BROWSER` to its executable path before running the command. The checked-in sound file is the deterministic output of `sound/render_score.py`; rebuilding sound additionally needs Python 3 and numpy.

Rendering uses two workers to limit peak memory. Outputs go to `../dist/assets/film/`:

- `promo-zh.mp4` and `promo-en.mp4`: H.264 / AAC, 42 seconds.
- `poster-zh.jpg` and `poster-en.jpg`: frame 235 from the matching composition.
- `score.wav`: original sound source, with no external recordings or samples.

`npm run studio` opens the editable composition. All motion is frame-driven via `useCurrentFrame` and interpolation, so exported frames do not depend on wall-clock timers or CSS animation state. The film uses system Chinese fonts; the release render uses macOS PingFang SC. Other systems need an appropriate CJK font to reproduce the typography.

## Storyboard

| Time | Story | Motion |
| --- | --- | --- |
| 0–5s | From a conversation to a next step | Brand opening and kinetic typography on a light canvas |
| 5–12s | A place for ongoing work | Layered workspace reveal with three slices from actual App captures |
| 12–20s | Start with the source | The real PDF page unfolds into view; camera moves toward the reading focus |
| 20–25s | Make the work your own | Close camera framing moves across the real editor title and document text |
| 25–29s | Review the change | Lateral camera move across the actual file tree and colored diff lines |
| 29–36s | Make room for the next step | Pull back from a calendar column to the surrounding week |
| 36–39s | Local first and model choice | Three short typographic statements; accurate remote-model data caveat |
| 39–42s | AI Bro | Brand signature, product promise and the real project URL |

The website uses the rendered videos, not a React or Remotion runtime. Playback is user-initiated; native controls, chapter navigation and download links remain available. No third-party tracking, font request or cloud rendering service is required.

## Visual references

The user selected these two references for motion direction:

- [CodePilot reference posted by op7418](https://x.com/op7418/status/2103148288400924827)
- [OpenCode motion reference posted by xueyu1125](https://x.com/xueyu1125/status/2104403240301609351)

They inform the light visual direction, product-focused camera framing, layering and typographic rhythm. AI Bro uses an original timeline, composition code, product copy and synthesized score. No reference video frames, logos, music or product UI are reused. All featured interface imagery remains the actual AI Bro captures described above. The references are design inspiration, not evidence of AI Bro functionality or any endorsement.

## Dependencies and attribution

React/React DOM and Remotion versions are pinned in this directory's lockfile independently of the App dependencies. Remotion's SDK has its own [license and pricing terms](https://www.remotion.dev/docs/license/pricing); installing it does not relicense that SDK under this repository's license. This repository's original composition code and synthesized soundtrack use the repository license. The generated video includes actual AI Bro interface imagery, with existing product component and font attributions retained in the App's [third-party notice](../../docs/THIRD_PARTY.md).

Implementation follows Remotion's official [frame-driven animation](https://www.remotion.dev/docs/animating-properties) and [rendering](https://www.remotion.dev/docs/render) documentation. Do not substitute synthetic UI frames or actual user records when updating the film.
