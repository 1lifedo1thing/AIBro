# AI Bro · 84-second product film

This is the editable source for the bilingual Mac study and research film. It is isolated from the earlier `product-film.jsx` project. The supported entry point is `src/motion-full-index.jsx`: 1920 × 1080, 60 fps, 5,040 frames.

The film uses actual captures of a fictional workspace, with editorial framing and condensed waits. Screen-position outlines are illustrations, not desktop recordings. Chinese native UI remains Chinese in both exports; English titles explain it. Source sessions are edited together, not presented as one continuous execution. The music is original synthesis without third-party samples or narration.

## Render

Install the pinned dependencies in the parent `launch/film` directory with `npm ci`, and have FFmpeg available. Extract the matching [motion84-assets-20261002.zip](https://github.com/zihenghe04/AIBro/releases/download/v0.8.0/motion84-assets-20261002.zip) into `launch/dist`; keep the two `citation-open-real-031.jpg` / `032.jpg` supplements, the three PNGs in `assets/film/capture-current-20261003/`, and `assets/film/task-current-20261003/project-next-task-current.png` supplied in the repository. All image and music files are checked against `asset-manifest.json`. The existing `assets/mark.png` is reused from the repository and is not duplicated in the archive.

From the repository root:

```sh
node launch/film/motion84/check-assets.mjs
node launch/film/motion84/render.mjs
```

`RENDER_LANGS=zh` or `RENDER_LANGS=en` renders only one language. `FILM_PUBLIC_DIR`, `CHROME_PATH` and `FFMPEG_PATH` may point to local installations. The reference render used macOS, Google Chrome and PingFang SC / Helvetica Neue; other font environments can change text metrics. Six 14-second video segments are rendered sequentially with one worker, then joined without re-encoding. The selected A score is copied at unity gain; no extra normalization is applied.

The asset archive contains only allowlisted fictional demonstration images and the synthesized score. It excludes application data, local test receipts, credentials, original absolute paths and unused capture attempts. Old film source and releases remain separate.

## Rebuild the selected music

With Python 3, NumPy and FFmpeg available, run `python3 sound/render_motion_v3_score_r4.py --output sound/output` from this directory. It creates the original 84-second A arrangement and numerical loudness report. The committed audio manifest refers to the distributed AAC bytes; encoders/platforms may produce different container hashes when rebuilt. Music listening and preference are separate from a numerical report.

The motion approach was informed by [motion-video-kit](https://github.com/echris6/motion-video-kit): explain the purpose, guide attention through an operation, and show its result. No third-party product footage, artwork or music is included.

## Research recall revision

The 36.1–54.5 second chapter now follows one remembered question through its attributed answer, citation preview and original PDF table. `src/motion-research.jsx` supplies this continuous editorial camera; `motion-film.jsx` uses it in the supported full composition. Captured UI pixels and native source actions are reused from the same distributed asset archive. The 84-second duration and A music are unchanged. Camera movement is editorial framing, not generated App scrolling.

## Saved-note revision

At 54.5–60.7 seconds, the current native panel shows a manual edit to an existing observation and its saved result. `motion-v3/capture-current.json` maps the three unchanged native captures. The following 60.7–67.9-second segment reviews the earlier course association and organized notes; it does not claim a new association or AI synthesis during that edit. English research labels translate the remembered question and explain the waiting-time comparison. All scene times and the selected A soundtrack remain unchanged.

## Course-task handoff revision

The island task list leads into the course overview, then the same existing task and its five unchecked steps. The current task-detail capture was saved and reopened after a manual description edit in the fictional workspace. It is not new AI work or a completed task. The title holds across the course transition; the full task dialog appears before the camera moves to its checklist. Duration, earlier chapters and the A soundtrack are unchanged.

## Course-note framing revision

At 60.7–67.9 seconds, the earlier course association and its saved result use a wider frame. The course label and original note remain readable; the result holds all six observation questions without clipping the last row or exposing internal record IDs. This revisits the earlier synthesis, rather than showing a new AI execution. Actual captures, chapter timing, the 84-second duration and A soundtrack are unchanged.
