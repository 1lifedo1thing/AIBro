# AI Bro product page

A bilingual static product website for the Mac App. The design retains the earlier site's immersive dark hero, large product imagery, alternating workflow chapters and viewport-aware motion. Product images come from the actual **AI Bro 0.8.0 native App**, captured in an isolated workspace containing only fictional materials.

Chinese is the default; `?lang=en` selects English. The canonical site is [zihenghe04.github.io/AIBro](https://zihenghe04.github.io/AIBro/), and download links target [v0.8.0](https://github.com/zihenghe04/AIBro/releases/tag/v0.8.0). Website changes do not rebuild or replace the App.

## Local preview

No dependency installation or build is required:

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory launch/dist
```

Open `http://127.0.0.1:8080/` and `http://127.0.0.1:8080/?lang=en`. This serves public marketing assets, not a user workspace. The page has no external font service, analytics script, or media CDN.

| File | Purpose |
| --- | --- |
| `dist/index.html` | Semantic Chinese content, real App screenshots, video controls, FAQ and downloads |
| `dist/style.css` | Typography, dark olive palette, alternating media layout, responsive and reduced-motion styles |
| `dist/script.js` | English translations, language history, viewport playback, motion controls and image dialog |
| `dist/assets/mark.png` | Existing App brand mark |
| `dist/assets/demo/native-*.png` | Actual native App screenshots: overview, reader, editor and agenda |
| `dist/assets/demo/hero-workspace.png` | Actual App screenshot used by README and the film poster |
| `dist/assets/demo/workflow-film.mp4` | Combined screenshot sequence |
| `dist/assets/demo/{source-to-note,review-to-save,plan-to-agenda}.{mp4,gif}` | Three workflow sequences, with GIF alternatives for GitHub |

## Interaction and motion

- An immersive hero introduces the product; a separate unshaded, high-resolution image lets visitors inspect the real workspace.
- The film has native playback controls. Workflow chapters preload near the viewport, play when visible, and pause when offscreen or the page is hidden.
- Visitors can pause page motion, play individual chapters, download GIFs, or enlarge screenshots in a keyboard-accessible native dialog. Escape closes the dialog and focus returns to the trigger.
- Reduced-motion preferences disable automatic playback and entrance movement. Content remains readable without JavaScript.
- The English dictionary must cover visible copy and accessible labels. Language changes preserve the URL hash; back/forward navigation restores the selected language.
- Failed media retains access to the real screenshot and reports a readable status instead of leaving an empty frame.

The page uses CSS transitions and browser media APIs rather than adding a framework runtime solely for presentation. Its motion should direct attention to actual product details, not simulate unimplemented UI.

## Media provenance

All current product screenshots were captured from the native 0.8.0 App on 2026-10-01. The capture App uses the released executable and frontend resources, with a distinct bundle identifier and a separate demo workspace. Public examples include a fictional interaction-design course, an urban-transport research project, and a weekend plan. No production workspace, account, credentials, server addresses, or personal documents are included.

The videos and GIFs are **sequences of actual screenshots** with editing transitions. They are not continuous screen recordings, live model executions, or model-speed benchmarks. Both website languages and README captions state this distinction. The screenshots show the Chinese App interface in either website language.

Do not reintroduce generated product mockups, fabricated tool results or unreviewed screenshots. The earlier `assets/recordings/`, `assets/ios/`, and `features.json` remain historical assets and are not referenced by the current landing page. A historical asset is not automatically approved for reuse.

## Publication checklist

Verify Chinese and English at desktop and narrow widths; image enlargement and focus restoration; film and chapter playback; pause controls; keyboard access; reduced motion; local asset references; image encodings; and privacy of every newly published frame. Check readable type, image aspect ratios and media size as well as JavaScript syntax. Browser acceptance is separate from App acceptance.

The [Pages workflow](../.github/workflows/pages.yml) publishes `launch/dist` on matching `main` changes, only for the public `zihenghe04/AIBro` repository. Publish from the sanitized public checkout, never private development history. Confirm the exact commit's successful Pages deployment and the resulting live page. Keep product claims aligned with the downloadable version; a successful website deployment does not establish App feature correctness.
