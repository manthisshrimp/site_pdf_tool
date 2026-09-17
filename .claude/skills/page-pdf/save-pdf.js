#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (_) {}
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(globalRoot, 'playwright'));
  } catch (_) {}
  console.error(
    'playwright not found. Install it in this project (or globally):\n' +
      '  npm install -D playwright && npx playwright install chromium'
  );
  process.exit(1);
}

const { chromium, devices } = loadPlaywright();

// Chromium refuses PDF pages larger than 200in; stay under it.
const MAX_PAGE_PX = 18000;

// The print layout lands slightly past the measured height, which spills an
// otherwise-complete page onto a near-empty extra one. The slack absorbs that;
// it only ever shows as page background below the footer.
const PAGE_SLACK_PX = 48;

// Upper bound for the reveal pass viewport, so a very long page cannot blow up
// memory by laying itself out all at once.
const REVEAL_VIEWPORT_CAP = 20000;

const CONSENT_BUTTON_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#accept-recommended-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  '#didomi-notice-agree-button',
  '.osano-cm-accept-all',
  '#truste-consent-button',
  '#cookiescript_accept',
  '#hs-eu-confirmation-button',
  '.cm-btn-success',
  '.cc-allow',
  '.cookie-accept',
  'button[data-testid="uc-accept-all-button"]',
  'button[data-cky-tag="accept-button"]',
  'button#shopify-pc__banner__btn-accept',
  '.qc-cmp2-summary-buttons button[mode="primary"]',
  '[id*="cookie" i] button[id*="accept" i]',
  '[class*="cookie" i] button[class*="accept" i]',
];

const CONSENT_TEXT = /^(accept|accept all|accept all cookies|accept cookies|allow all|allow all cookies|allow cookies|i accept|i agree|agree|agree and close|got it|ok|okay|okay, got it|ok, got it|understood|continue|yes, i agree|accept & close|close and accept)$/i;

const CONSENT_CONTAINERS = [
  '#onetrust-consent-sdk',
  '#onetrust-pc-dark-filter',
  '#CybotCookiebotDialog',
  '#CybotCookiebotDialogBodyUnderlay',
  '#didomi-host',
  '.osano-cm-window',
  '#truste-consent-track',
  '#cookiescript_injected',
  '#usercentrics-root',
  '.qc-cmp2-container',
  '.qc-cmp-cleanslate',
  '.cky-consent-container',
  '.cky-overlay',
  '#cookie-banner',
  '[class*="cookie-banner" i]',
  '[class*="cookie-consent" i]',
  '[id*="cookie-notice" i]',
];

const OVERLAY_NAME_HINT = /cookie|consent|gdpr|cmp|privacy|underlay|backdrop|overlay/i;

function parseArgs(argv) {
  const opts = {
    url: null,
    mobile: false,
    device: null,
    out: null,
    outDir: 'output',
    width: null,
    height: null,
    paper: null,
    pageHeight: null,
    timeout: 60000,
    wait: 0,
    maxScrolls: 60,
    settle: 350,
    consentTimeout: 12000,
    revealSettle: 2500,
    forceReveal: false,
    keepBanners: false,
    printCss: false,
    scale: 1,
    quiet: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--mobile': opts.mobile = true; break;
      case '--desktop': opts.mobile = false; break;
      case '--device': opts.device = next(); opts.mobile = true; break;
      case '--out': case '-o': opts.out = next(); break;
      case '--out-dir': opts.outDir = next(); break;
      case '--width': opts.width = parseInt(next(), 10); break;
      case '--height': opts.height = parseInt(next(), 10); break;
      case '--paper': opts.paper = next(); break;
      case '--page-height': opts.pageHeight = parseInt(next(), 10); break;
      case '--timeout': opts.timeout = parseInt(next(), 10); break;
      case '--wait': opts.wait = parseInt(next(), 10); break;
      case '--max-scrolls': opts.maxScrolls = parseInt(next(), 10); break;
      case '--settle': opts.settle = parseInt(next(), 10); break;
      case '--force-reveal': opts.forceReveal = true; break;
      case '--reveal-settle': opts.revealSettle = parseInt(next(), 10); break;
      case '--consent-timeout': opts.consentTimeout = parseInt(next(), 10); break;
      case '--keep-banners': opts.keepBanners = true; break;
      case '--print-css': opts.printCss = true; break;
      case '--scale': opts.scale = parseFloat(next()); break;
      case '--quiet': opts.quiet = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
        rest.push(a);
    }
  }
  opts.url = rest[0] || null;
  return opts;
}

const USAGE = `Usage: node save-pdf.js <url> [options]

  --mobile                 emulate a phone (default device: iPhone 17)
  --device "<name>"        any Playwright device name, implies --mobile
  --desktop                desktop viewport (default, 1440x900)
  -o, --out <file>         output path (default: <out-dir>/<slug>-<mode>.pdf)
  --out-dir <dir>          output directory (default: ./output)
  --width/--height <px>    override viewport size
  --page-height <px>       split into pages of this height instead of one tall
                           page; helps viewers that choke on a huge page
  --paper <A4|Letter|...>  paginated paper PDF instead of one tall page
  --print-css              render print stylesheet instead of screen CSS
  --scale <n>              PDF scale, 0.1-2 (default 1)
  --timeout <ms>           navigation timeout (default 60000)
  --wait <ms>              extra settle time before capture
  --max-scrolls <n>        lazy-load scroll passes (default 60)
  --force-reveal           unhide scroll-reveal animation elements
  --reveal-settle <ms>     wait for reveal animations to finish (default 2500)
  --keep-banners           do not dismiss cookie/consent banners
  --consent-timeout <ms>   how long to wait for a consent banner (default 12000)
  --quiet                  only print the result JSON
`;

function log(opts, ...args) {
  if (!opts.quiet) console.error(...args);
}

function slugify(url, mode) {
  const u = new URL(url);
  const pathPart = u.pathname.replace(/\/+$/, '').replace(/^\//, '').replace(/[^\w.-]+/g, '-');
  return [u.hostname.replace(/^www\./, ''), pathPart, mode].filter(Boolean).join('-').slice(0, 120);
}

// Consent dialogs are routinely taller than the viewport or covered by their
// own backdrop, which defeats Playwright's actionability checks, so fall back
// to dispatching the click straight at the element.
async function clickElement(locator) {
  try {
    await locator.click({ timeout: 2000, noWaitAfter: true });
  } catch (_) {
    await locator.evaluate((el) => el.click());
  }
}

async function clickConsentButton(page) {
  for (const frame of page.frames()) {
    for (const sel of CONSENT_BUTTON_SELECTORS) {
      try {
        const loc = frame.locator(sel).first();
        if (await loc.isVisible()) {
          await clickElement(loc);
          return sel;
        }
      } catch (_) {}
    }
    try {
      const byRole = frame.getByRole('button', { name: CONSENT_TEXT });
      const n = Math.min(await byRole.count(), 4);
      for (let i = 0; i < n; i++) {
        const loc = byRole.nth(i);
        if (await loc.isVisible()) {
          const label = ((await loc.textContent().catch(() => '')) || '').trim();
          await clickElement(loc);
          return `button:"${label}"`;
        }
      }
    } catch (_) {}
  }
  return null;
}

function consentStillVisible(page, selectors) {
  return page.evaluate(
    (sels) =>
      sels.some((sel) =>
        Array.from(document.querySelectorAll(sel)).some((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
        })
      ),
    selectors
  );
}

// Consent UIs are injected asynchronously, so poll rather than look once.
async function dismissConsent(page, opts) {
  const clicked = [];
  const deadline = Date.now() + opts.consentTimeout;
  while (Date.now() < deadline) {
    const hit = await clickConsentButton(page);
    if (hit) {
      clicked.push(hit);
      await page.waitForTimeout(900);
      if (!(await consentStillVisible(page, CONSENT_CONTAINERS))) break;
    } else {
      if (clicked.length && !(await consentStillVisible(page, CONSENT_CONTAINERS))) break;
      await page.waitForTimeout(500);
    }
  }

  // Hide whatever survived: leftover banners and the dimming backdrops they
  // leave behind, which would otherwise tint the whole capture.
  const hidden = await page.evaluate(
    ({ selectors, hintSource }) => {
      const hint = new RegExp(hintSource, 'i');
      const hide = (el) => el.style.setProperty('display', 'none', 'important');
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
      };
      const found = [];

      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (visible(el)) {
            hide(el);
            found.push(sel);
          }
        }
      }

      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' || !visible(el)) continue;
        const r = el.getBoundingClientRect();
        const coversViewport = r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9;
        if (!coversViewport || (parseInt(cs.zIndex, 10) || 0) < 1000) continue;
        const name = `${el.id} ${el.className}`;
        const dimmer = !el.textContent.trim() && /rgba?\(0, ?0, ?0/.test(cs.backgroundColor);
        if (hint.test(name) || dimmer) {
          hide(el);
          found.push(el.id ? `#${el.id}` : `fixed-overlay.${String(el.className).slice(0, 30)}`);
        }
      }

      // Banners commonly lock scrolling; undo it only where it was applied.
      for (const el of [document.documentElement, document.body]) {
        if (getComputedStyle(el).overflow === 'hidden') el.style.setProperty('overflow', 'visible', 'important');
        if (getComputedStyle(el).position === 'fixed') el.style.setProperty('position', 'static', 'important');
      }
      return found;
    },
    { selectors: CONSENT_CONTAINERS, hintSource: OVERLAY_NAME_HINT.source }
  );

  return { clicked, hidden };
}

async function loadLazyContent(page, opts) {
  await page.evaluate(
    async ({ maxScrolls, settle }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
      let lastHeight = -1;
      let stable = 0;
      for (let i = 0; i < maxScrolls; i++) {
        window.scrollBy(0, step);
        await sleep(settle);
        const h = document.documentElement.scrollHeight;
        const atBottom = window.scrollY + window.innerHeight >= h - 4;
        stable = h === lastHeight ? stable + 1 : 0;
        lastHeight = h;
        if (atBottom && stable >= 2) break;
      }
      window.scrollTo(0, 0);
      await sleep(300);
    },
    { maxScrolls: opts.maxScrolls, settle: opts.settle }
  );

  // Promote anything still deferred, then wait for it to actually arrive.
  await page.evaluate(() => {
    for (const img of document.querySelectorAll('img')) {
      img.loading = 'eager';
      const src = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
      if (src && !img.currentSrc) img.src = src;
      const srcset = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset');
      if (srcset && !img.srcset) img.srcset = srcset;
    }
    for (const frame of document.querySelectorAll('iframe[loading="lazy"]')) frame.loading = 'eager';
    for (const el of document.querySelectorAll('[data-bg],[data-background-image]')) {
      const bg = el.getAttribute('data-bg') || el.getAttribute('data-background-image');
      if (bg) el.style.backgroundImage = `url("${bg}")`;
    }
  });

  await page.evaluate(() => {
    const pending = Array.from(document.images).filter((i) => !i.complete);
    return Promise.all(
      pending.map(
        (i) =>
          new Promise((res) => {
            i.addEventListener('load', res, { once: true });
            i.addEventListener('error', res, { once: true });
            setTimeout(res, 5000);
          })
      )
    ).then(() => undefined);
  });

  await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => undefined) : undefined));
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
}

// The PDF page box is as tall as the whole document, and viewport-height units
// resolve against that box when printing — so `min-height: 100svh` becomes the
// full document height and balloons the first section. Rewrite those units to
// the pixel height they had on screen.
async function freezeViewportUnits(page, viewportHeight) {
  return page.evaluate((vh) => {
    const UNIT = /(-?[\d.]+)(dvh|svh|lvh|vh)\b/;
    const toPx = (value) =>
      value.replace(new RegExp(UNIT, 'g'), (_, n) => `${(parseFloat(n) * vh) / 100}px`);
    let changed = 0;

    const rewrite = (style) => {
      for (const prop of Array.from(style)) {
        const value = style.getPropertyValue(prop);
        if (!UNIT.test(value)) continue;
        style.setProperty(prop, toPx(value), style.getPropertyPriority(prop));
        changed++;
      }
    };

    const walk = (rules) => {
      for (const rule of rules) {
        if (rule.style) rewrite(rule.style);
        if (rule.cssRules) walk(rule.cssRules);
      }
    };

    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules);
      } catch (_) {
        // cross-origin stylesheet, not readable
      }
    }
    for (const el of document.querySelectorAll('[style*="vh"]')) rewrite(el.style);
    return changed;
  }, viewportHeight);
}

// A sticky-footer wrapper (flex column, footer on `margin-top: auto`) stretches
// to fill the PDF page box when printing, so the auto margin pushes the footer
// to the bottom of the page and the last sections flow underneath it. Pinning
// those wrappers to their measured height leaves no free space to distribute.
async function pinFooterWrappers(page) {
  return page.evaluate(() => {
    const footer = document.querySelector('footer');
    if (!footer) return 0;
    let pinned = 0;
    for (let el = footer.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (!style.display.includes('flex') || !style.flexDirection.startsWith('column')) continue;
      // Block layout stacks these children the same way but resolves the
      // footer's `margin-top: auto` to zero, so it stays with the content.
      el.style.setProperty('display', 'block', 'important');
      pinned++;
    }
    return pinned;
  });
}

// Printing while animations are still running gives a different result every
// time, and half-finished reveals clip their own content. Land every finite
// animation on its end state and stop the endless ones (marquees, spinners).
async function settleAnimations(page) {
  const settled = await page.evaluate(() => {
    let count = 0;
    for (const animation of document.getAnimations()) {
      try {
        if (animation.effect && animation.effect.getTiming().iterations === Infinity) animation.pause();
        else animation.finish();
        count++;
      } catch (_) {
        // an animation that cannot be finished (unresolved timeline) is left alone
      }
    }
    return count;
  });
  await page.waitForTimeout(300);
  return settled;
}

// Printing re-resolves responsive images at the print pixel ratio, which can
// pick a different srcset candidate than the one measured on screen and shift
// every box below it. Pin each image to the file it is actually showing.
async function freezeImageSources(page) {
  return page.evaluate(() => {
    let pinned = 0;
    for (const img of document.querySelectorAll('img')) {
      const chosen = img.currentSrc;
      if (chosen && chosen !== img.src) img.src = chosen;
      if (img.srcset || img.sizes) {
        img.removeAttribute('srcset');
        img.removeAttribute('sizes');
        pinned++;
      }
    }
    for (const source of document.querySelectorAll('picture source')) source.remove();

    // Print re-derives an auto-sized image box from the file's intrinsic ratio,
    // which can come out taller than what was measured and push the following
    // content under the next section. Lock each box to its rendered size.
    for (const img of document.querySelectorAll('img')) {
      const box = img.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      img.style.setProperty('width', `${box.width}px`, 'important');
      img.style.setProperty('height', `${box.height}px`, 'important');
    }
    return pinned;
  });
}

// Reveal animations are driven by IntersectionObserver, and many re-hide their
// element once it leaves the viewport — so after a scroll pass most of the page
// is hidden again. Stretching the viewport over the whole document puts every
// element in view at once and lets the page reveal them through its own logic,
// which also tears down the per-line text masks it uses for headings.
async function revealPass(page, opts, width) {
  const docHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const height = Math.min(docHeight, REVEAL_VIEWPORT_CAP);
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(opts.revealSettle);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  return height;
}

// Scroll-reveal wrappers hide their content with a zero-area clip-path and only
// open it while the element is in view, so anything the scroll pass has left
// behind stays clipped away at print time. Drop clips that erase the element;
// a clip that actually shows something is left alone.
async function unclipHiddenReveals(page) {
  return page.evaluate(() => {
    const polygonArea = (clip, box) => {
      const inner = clip.slice(clip.indexOf('(') + 1, clip.lastIndexOf(')'));
      const points = inner.split(',').map((pair) => {
        const [x, y] = pair.trim().split(/\s+/);
        const toPx = (v, size) => (String(v).endsWith('%') ? (parseFloat(v) / 100) * size : parseFloat(v));
        return [toPx(x, box.width), toPx(y, box.height)];
      });
      if (points.length < 3 || points.some(([x, y]) => Number.isNaN(x) || Number.isNaN(y))) return null;
      let sum = 0;
      for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[(i + 1) % points.length];
        sum += x1 * y2 - x2 * y1;
      }
      return Math.abs(sum) / 2;
    };

    let unclipped = 0;
    for (const el of document.querySelectorAll('*')) {
      const style = getComputedStyle(el);
      if (!style.clipPath.startsWith('polygon')) continue;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const area = polygonArea(style.clipPath, box);
      if (area === null || area >= box.width * box.height * 0.05) continue;
      el.style.setProperty('clip-path', 'none', 'important');
      el.style.setProperty('animation', 'none', 'important');
      unclipped++;
    }
    return unclipped;
  });
}

async function forceReveal(page) {
  await page.addStyleTag({
    content: `[data-aos],.aos-init,.reveal,.fade-in,.fade-up,.animate,[class*="animate-"],[class*="reveal"],[class*="fade"] {
      opacity: 1 !important;
      transform: none !important;
      visibility: visible !important;
      clip-path: none !important;
    }`,
  });
}

async function render(opts) {
  const mode = opts.mobile ? 'mobile' : 'desktop';
  const outPath = path.resolve(opts.out || path.join(opts.outDir, `${slugify(opts.url, mode)}.pdf`));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const deviceName = opts.device || (opts.mobile ? 'iPhone 17' : null);
  if (deviceName && !devices[deviceName]) throw new Error(`Unknown device: ${deviceName}`);

  const contextOptions = deviceName
    ? { ...devices[deviceName] }
    : { viewport: { width: opts.width || 1440, height: opts.height || 900 } };
  if (opts.width || opts.height) {
    contextOptions.viewport = {
      width: opts.width || contextOptions.viewport.width,
      height: opts.height || contextOptions.viewport.height,
    };
  }
  // page.pdf() needs Chromium's headless print path; a mobile descriptor's
  // defaultBrowserType would otherwise select WebKit semantics.
  delete contextOptions.defaultBrowserType;
  // No reducedMotion override: carousels and marquees lay their items out from
  // the running animation, and disabling it collapses them into one overlapping
  // pile instead of the few slides actually on screen.
  contextOptions.locale = contextOptions.locale || 'en-US';

  // No --font-render-hinting override: it shifts text metrics, so the measured
  // layout and the print layout disagree and the footer rides up over the last
  // section's content.
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--disable-gpu'] });
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(opts.timeout);

  const result = { url: opts.url, mode, device: deviceName || 'desktop', output: outPath };
  try {
    log(opts, `→ ${opts.url} (${mode}${deviceName ? `, ${deviceName}` : ''})`);
    const response = await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
    result.status = response ? response.status() : null;
    await page.waitForLoadState('load', { timeout: opts.timeout }).catch(() => {});
    await page.waitForTimeout(1200);

    if (!opts.keepBanners) {
      const consent = await dismissConsent(page, opts);
      result.consent = consent;
      log(opts, `  consent: clicked=[${consent.clicked.join(', ') || 'none'}] hidden=[${consent.hidden.join(', ') || 'none'}]`);
    }

    await loadLazyContent(page, opts);

    // Pin viewport units to the phone's height before the viewport is stretched
    // for the reveal pass, so the layout stays the one a phone would show.
    if (!opts.paper) {
      result.frozenViewportUnits = await freezeViewportUnits(page, contextOptions.viewport.height);
      log(opts, `  pinned ${result.frozenViewportUnits} viewport-height declarations`);
    }
    result.revealViewport = await revealPass(page, opts, contextOptions.viewport.width);
    result.pinnedImages = await freezeImageSources(page);
    result.settledAnimations = await settleAnimations(page);
    result.pinnedWrappers = await pinFooterWrappers(page);
    result.unclipped = await unclipHiddenReveals(page);
    log(opts, `  reveal pass at ${contextOptions.viewport.width}x${result.revealViewport}, unclipped ${result.unclipped}, pinned ${result.pinnedImages} images, settled ${result.settledAnimations} animations, pinned ${result.pinnedWrappers} wrappers`);
    if (opts.forceReveal) await forceReveal(page);
    if (opts.wait) await page.waitForTimeout(opts.wait);

    result.title = await page.title();
    await page.emulateMedia({ media: opts.printCss ? 'print' : 'screen' });

    const metrics = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      height: Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.offsetHeight
      ),
      images: document.images.length,
    }));
    result.contentHeight = metrics.height;
    result.images = metrics.images;

    const pdfOptions = { path: outPath, printBackground: true, scale: opts.scale };
    if (opts.paper) {
      pdfOptions.format = opts.paper;
      pdfOptions.margin = { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' };
    } else {
      const width = contextOptions.viewport.width;
      const total = metrics.height + PAGE_SLACK_PX;
      const limit = Math.min(opts.pageHeight || MAX_PAGE_PX, MAX_PAGE_PX);
      const pages = Math.max(1, Math.ceil(total / limit));
      const pageHeight = Math.ceil(total / pages);
      pdfOptions.width = `${width}px`;
      pdfOptions.height = `${pageHeight}px`;
      pdfOptions.margin = { top: '0', bottom: '0', left: '0', right: '0' };
      // Anything past the pages we sized for is spill, not content.
      pdfOptions.pageRanges = `1-${pages}`;
      result.pdfPageSize = `${width}x${pageHeight}px`;
      result.pdfPages = pages;
    }
    await page.pdf(pdfOptions);
    result.bytes = fs.statSync(outPath).size;
    result.ok = true;
  } catch (err) {
    result.ok = false;
    result.error = err.message;
  } finally {
    await context.close();
    await browser.close();
  }

  return result;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.url) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 1);
  }
  if (!/^https?:\/\//i.test(opts.url)) opts.url = `https://${opts.url}`;

  const result = await render(opts);

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
