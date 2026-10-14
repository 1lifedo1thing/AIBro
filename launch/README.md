# AI Bro product page

A bilingual static product website for the Mac App, redesigned for **0.9.5**. The page is light and warm off-white with sage accents to match the App's Liquid Glass UI: a centred hero with the real App window at near-full width, a "new in 0.9.5" strip, three feature chapters (ask + agent timeline, cited answers, PDF selection → Ask AI) each anchored to a real recording or capture, a bento of everyday features (split reader, agenda card, dark appearance, local-first and model choice), the product film, FAQ and a download panel. All product imagery comes from the **AI Bro 0.9.5** App in an isolated demo workspace with fictional materials and scripted model answers.

Chinese is the default; `?lang=en` selects English. The canonical site is [zihenghe04.github.io/AIBro](https://zihenghe04.github.io/AIBro/), and download links target [v0.9.5](https://github.com/zihenghe04/AIBro/releases/tag/v0.9.5). Website changes do not rebuild or replace the App.

## Local preview

No dependency installation or build is required:

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory launch/dist
```

Open `http://127.0.0.1:8080/` and `http://127.0.0.1:8080/?lang=en`. This serves public marketing assets, not a user workspace. The page has no external font service, analytics script, or media CDN.

| File | Purpose |
| --- | --- |
| `dist/index.html` | Semantic Chinese content, real App captures, recordings, film, FAQ and downloads |
| `dist/style.css` | System-font typography, light sage theme, window framing, bento, responsive and reduced-motion styles |
| `dist/script.js` | English dictionary, language history, scroll reveal, viewport playback for recordings, film fallback and image dialog |
| `dist/assets/v095/*-{1600,2560}.avif` | 0.9.5 window captures flattened onto the page background (Chrome does not decode the alpha AVIFs `sips` writes), corners rounded in CSS |
| `dist/assets/v095/*-1600.png` | 256-colour PNG fallbacks with the original transparent corners |
| `dist/assets/v095/{course-qa,pdf-ask}.{webm,mp4}` | Window-cropped, muted 30 fps screen recordings, with JPEG posters |
| `dist/assets/film/promo-095-{zh,en}.mp4`, `promo-095-poster-{zh,en}.jpg` | 0.9.5 product film (rendered separately). Until these exist the film frame shows a still and a status line |

## Interaction and motion

- Recordings load near the viewport, play while visible, pause offscreen, while the zoom dialog is open, or when the page is hidden. Each has a play/pause button; failed media shows a retry state and the still remains available via "查看静帧".
- Reduced-motion preferences disable autoplay, entrance animation and scroll reveal. Content is visible without JavaScript (the reveal state is gated by a `.js` class).
- Screenshots open in a keyboard-accessible native dialog; Escape closes it and focus returns to the trigger.
- The English dictionary covers visible copy, alt text and accessible labels. Language changes preserve the URL hash; back/forward restores the language. The film source and poster follow the language.

## Media provenance

Captures and recordings were made on 2026-10-14 from the installed AI Bro 0.9.5 (build 914), copied to an isolated bundle with its own fictional workspace (an interaction-design course, a low-carbon transport project, a weekend plan). Model answers come from a local scripted mock; the App UI, tool steps, citations, PDF reader and selection toolbar are real. Recordings are continuous screen captures with waits left in, not speed benchmarks. The App interface is Chinese in both page languages, and the English page says so. The page discloses fictional data and scripted answers next to the media in both languages.

The 0.8.0 screenshots, workflow clips and films under `assets/demo/`, `assets/film/` (motion-84, promo-{zh,en}), `assets/recordings/`, `assets/ios/`, and `features.json` / `ios-gallery.js` are historical and not referenced by the page.

## Publication checklist

Verify Chinese and English at desktop and narrow widths; image enlargement and focus restoration; explicit film playback, each chapter jump and its timing; language changes during playback; pause/replay controls; failed-media recovery; keyboard access; reduced motion; local asset references; image encodings; and privacy of every newly published frame. Check readable type, image aspect ratios and media size as well as JavaScript syntax. Browser acceptance is separate from App acceptance.

The [Pages workflow](../.github/workflows/pages.yml) publishes `launch/dist` on matching `main` changes, only for the public `zihenghe04/AIBro` repository. Publish from the sanitized public checkout, never private development history. Confirm the exact commit's successful Pages deployment and the resulting live page. Keep product claims aligned with the downloadable version; a successful website deployment does not establish App feature correctness.
