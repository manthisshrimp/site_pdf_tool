---
name: page-pdf
description: Save a web page as a PDF in mobile or desktop view using Playwright, dismissing cookie/consent banners and forcing lazy-loaded content to load first. Use when asked to snapshot, archive, or "get a PDF of" a URL, in phone or desktop layout.
---

# Page → PDF

`save-pdf.js` drives headless Chromium: it loads a URL, accepts the cookie banner,
scrolls the whole page so lazy content loads, then writes a PDF.

## Setup (once per machine)

```bash
npm install -D playwright          # needs Node 20+
npx playwright install chromium
```

Chromium 140 mis-rendered scroll-animated pages and crashed on stylesheets
declaring `@font-face` `local()` sources; 153 fixes both. If pages come out
unstyled or the renderer crashes, check `npx playwright --version` first.

The script resolves `playwright` from the nearest `node_modules` or the global
npm root, so it runs from any directory once installed.

## Usage

```bash
node .claude/skills/page-pdf/save-pdf.js <url> [options]
```

```bash
# phone view (iPhone 17, 402px)
node .claude/skills/page-pdf/save-pdf.js https://example.com --mobile

# desktop view (1440x900), explicit output path
node .claude/skills/page-pdf/save-pdf.js https://example.com --desktop -o out/example.pdf

# a specific device, or a custom viewport width
node .claude/skills/page-pdf/save-pdf.js https://example.com --device "Pixel 7"
node .claude/skills/page-pdf/save-pdf.js https://example.com --width 1280

# A4 pages for something meant to be printed on paper
node .claude/skills/page-pdf/save-pdf.js https://example.com --paper A4
```

Run with `--help` for the full option list. Output defaults to
`./output/<host>-<path>-<mobile|desktop>.pdf`. The script prints a JSON summary
(status, title, consent buttons clicked, content height, page size, bytes) to
stdout and progress to stderr, so `--quiet` plus stdout parsing is scriptable.

## Checking the result

Chromium's own PDF engine renders the page: one tall page at the viewport width,
with real vector text. Always eyeball the output — render the pages small to
check the flow, then crop a region at full resolution to check text:

```bash
pdftoppm -png -r 11 out.pdf /tmp/check                            # whole page
pdftoppm -png -r 72 -f 2 -l 2 -y 300 -H 900 out.pdf /tmp/crop     # detail
```

## What it handles automatically

- **Consent banners** — known selectors for OneTrust, Cookiebot, Didomi, Osano,
  Usercentrics, Quantcast, TrustArc, CookieYes and others, plus any button whose
  label reads "Accept all" / "I agree" / "Got it", searched across iframes. It
  polls for up to 12s because these load late, and falls back to a direct DOM
  click when the dialog is taller than the viewport (Playwright's actionability
  check times out on those). Anything still standing afterwards — the banner and
  its dimming backdrop — gets hidden, and scroll locks are released.
- **Lazy content** — scrolls in viewport-sized steps until the page stops
  growing, promotes `loading="lazy"` images and `data-src`/`data-srcset`
  placeholders, waits for images and webfonts, then returns to the top.
- **Consent-locked scrolling** — banners that freeze `<body>` are unfrozen after
  dismissal, so the lazy-load pass can actually scroll.
- **Scroll reveals** — reveal animations run on IntersectionObserver and many
  re-hide their element once it leaves the viewport, so a print taken after
  scrolling is full of gaps: clipped cards, headings still behind their per-line
  masks. After the lazy-load pass the viewport is stretched over the whole
  document (capped at 20000px), which puts everything in view at once and lets
  the page reveal itself through its own logic. `--reveal-settle` controls the
  wait. As a fallback, any leftover `clip-path` covering under 5% of its
  element's box is dropped; clips that actually show something are left alone.
- **Viewport units** — the PDF page box is as tall as the whole document, and
  `vh`/`svh`/`dvh` resolve against that box when printing, so `min-height:100svh`
  would stretch the first section to the full document height. Those units are
  rewritten to the pixel values they had on screen before printing.

## Known limits

- `<video>` elements do not render; a poster frame may or may not appear.
- Pages taller than ~18000px are split across several PDF pages, because
  Chromium rejects a page dimension over 200 inches.
- The print layout lands slightly past the measured height, which used to spill
  a near-empty extra page. The page box now carries 48px of slack and the output
  is capped to the page count it was sized for, so any spill is dropped — at
  worst a few pixels of footer padding. Expect a small strip of page background
  below the footer.
- Scroll-driven sections (pinned heroes, scrub animations, parallax) render at
  whatever state the print layout resolves to, not mid-animation.
- Sites behind a login, hard bot-detection, or geo-blocking are out of scope.
- Firefox's built-in PDF viewer (pdf.js) tints these PDFs pink — it mishandles
  the ICC-tagged RGB images Chromium embeds. The file is fine; check it in
  Chromium, or with `pdftoppm`. `--page-height` splits the output into smaller
  pages for viewers that struggle with one very tall page.
- If a page renders blank, try `--force-reveal` (unhides scroll-reveal elements
  that never entered the viewport) or `--wait 5000`.
