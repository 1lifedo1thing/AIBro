# AI Bro product page

A bilingual static product website for the Mac app. The current page explains the path from source material to conversation, editable output and a next step. It is a marketing/documentation surface, separate from the app's WKWebView implementation and release package.

Chinese is the default; `?lang=en` selects English. The official target is [zihenghe04.github.io/AIBro](https://zihenghe04.github.io/AIBro/). Current download buttons point to the [Releases list](https://github.com/zihenghe04/AIBro/releases), including previews, without pinning an outdated package version.

## Files and local preview

| File | Purpose |
| --- | --- |
| `dist/index.html` | Chinese content, semantic structure, links, FAQ and recording disclosure |
| `dist/style.css` | Dark olive palette, system typography, responsive layout and focus/reduced-motion styles |
| `dist/script.js` | English text, language/history handling, anchor disclosure and recording lifecycle |
| `dist/assets/mark.png` | Existing brand mark; changing the website does not select or install a new app logo |
| `dist/assets/recordings/tour-{zh,en}.{jpg,mp4}` | Language-specific historical recording posters and videos |

Serve the static directory; no npm installation or build is needed:

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory launch/dist
```

Run this from the repository root, then open `http://127.0.0.1:8080/` and `http://127.0.0.1:8080/?lang=en`. Use another available port if necessary. This serves product-page assets, not the app or a user workspace.

The page has no external font service, analytics script or media CDN. Text is present in the Chinese HTML without JavaScript; the language switch is revealed after initialization. English translations live in the `EN` object in `script.js`, keyed by HTML `data-t` and `data-label` attributes. Add the Chinese text and matching English key together, including accessible labels. Language changes preserve the URL's existing query/hash; browser back/forward updates the selected language.

`features.json`, per-feature clips and the former iOS gallery remain as historical assets. The current page does **not** fetch `features.json` or render the earlier auto-playing feature grid. Editing that file alone will not update the current website.

## Layout and interaction

- The hero contains a labeled **workflow illustration, not an app screenshot**. It must not be presented as evidence of implemented UI.
- Sequential workflow, learning/research/daily scenarios, core capabilities, data/model choices, FAQ and download sections share a single scrolling page.
- Historical recordings are inside a native `details` disclosure. Video uses ordinary playback controls, `preload="none"` and no autoplay; the source is assigned when the disclosure opens.
- Switching language selects that language's real recording, pauses and clears the previous source, and updates the poster. Closing the recording section or hiding the document pauses playback. A failed video reports a status message and retains the download link.
- Direct anchors such as `#film`, `#ios` and `#ios-courses` reveal the relevant disclosure. Earlier feature anchors are retained where their content now lives.
- CSS provides visible keyboard focus, a skip link, responsive grids and reduced-motion overrides. These code paths require browser testing; their presence alone does not establish accessibility or performance acceptance.

The page does not show a fabricated current App screenshot, simulated generation, model-speed claim or an assurance that every source feature is already included in a downloadable build. The iOS companion is a historical FAQ link, while Mac remains the product focus.

## Recording provenance

The visible archive is explicitly labeled **recorded 2026-09-15**, using example workspaces and an earlier interface.

- Chinese: the user's approximately two-minute ScreenCam export, `屏幕录制-20260915-162058.mp4`; source SHA-256 `5cd0fa2ffec80e91a5854ffa9bd7ebe8bcb9b7a6fb6337e6b23c50f412c8c051`. The existing background, cursor and shadows came from that recording.
- English: a separate task-editing recording, `screen-cam-1789458513.mp4`, edited from source intervals 104–123, 190–205 and 213–220 seconds without increasing playback speed.
- These are edited recordings of actual interface operations. They are not live model benchmarks or acceptance evidence for the current app version. The English page does not substitute Chinese footage.

The earlier nine Chinese feature intervals are retained for provenance and possible reuse:

| Feature | Original source interval, seconds |
| --- | --- |
| Overview | 0.4–7.2 |
| File review | 9.1–24.3 |
| Calendar | 25.4–31.3 |
| Captures | 39.1–55.2 |
| Project charts | 57.5–69.8 |
| Project reader | 78.8–86.9 |
| Research Wiki | 95.5–103.1 |
| History and trash | 104.0–112.7 |
| Model settings | 114.1–117.7 |

Legacy iOS images in `assets/ios/` came from an isolated simulator with fictional data; course attendance states were simulated. They are not displayed by the current page. Keep these distinctions if reusing the assets.

## Maintenance and publication

Before publication, check both languages and narrow/desktop widths, keyboard navigation, FAQ/recording disclosure, direct anchors, back/forward language changes, missing-video feedback, visible focus and reduced motion. Confirm that all local assets are included in the public source export. JavaScript syntax and reference checks are useful, but do not substitute for rendered browser acceptance.

The deployment workflow is [`.github/workflows/pages.yml`](../.github/workflows/pages.yml). It uploads `launch/dist` on matching `main` changes or manual dispatch, and only deploys for the public `zihenghe04/AIBro` repository. Source mirrors and forks do not deploy the canonical website. A local file edit does not prove successful Pages publication.

Use the sanitized public checkout for publication; do not push private development history, workspace data, unreviewed screenshots or recording caches. Keep app release notes and website claims aligned with the actual downloadable version. Publishing this page does not update the installed app, create a GitHub app release or validate new product functionality.
