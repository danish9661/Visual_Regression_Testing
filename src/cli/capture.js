import fs from 'node:fs'; // import node file system
import path from 'node:path';// import node path
import { chromium, errors as playwrightErrors } from 'playwright';// chromium is the engine on which google chrome is based on. Our robot will directly bypass the
// chrome or other browser and use the chromium engine instead which is a lot lighter and faster. 

export { getRouteSlug, getSnapshotFilename } from './naming.js';
import { getSnapshotFilename } from './naming.js';
import { CliError } from './errors.js';
import { redactUrl, redactUrlsInText } from './display.js';
import { sanitizeMessage } from './result.js';

const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

/**
 * The error to throw when Chromium fails to launch: BROWSER_MISSING (with the command
 * that fixes it) when the browser or its system libraries are not installed,
 * otherwise the original error.
 *
 * @param {unknown} err
 * @returns {unknown}
 */
export function toLaunchError(err) {
  const message = String(err?.message ?? err);
  if (message.includes("Executable doesn't exist")) {
    return new CliError('BROWSER_MISSING',
      `Playwright's Chromium is not installed (${firstLine(err)}). Install it with: npx playwright install chromium`, { cause: err });
  }
  if (message.includes('Host system is missing dependencies')) {
    return new CliError('BROWSER_MISSING',
      'Chromium cannot start: the host system is missing libraries it needs. Install them with: npx playwright install --with-deps chromium', { cause: err });
  }
  return err;
}

/**
 * The error to throw when page.goto fails: NAVIGATION_FAILED naming the (redacted)
 * URL, except when the browser itself went away, which is not the site's fault and
 * stays an internal error.
 *
 * @param {unknown} err
 * @param {string} url
 * @returns {unknown}
 */
export function toNavigationError(err, url) {
  const message = String(err?.message ?? err);
  if (/Target page, context or browser has been closed|Target closed|Browser has been closed/i.test(message)) {
    return new CliError('INTERNAL', `The browser closed while loading ${redactUrl(url)}: ${redactUrlsInText(firstLine(err))}`, { cause: err });
  }
  // First line only: the rest is Playwright's call log. Redacted: the URL can carry
  // credentials, and this message ends up in logs and the JSON result.
  return new CliError('NAVIGATION_FAILED', `Could not load ${redactUrl(url)}: ${redactUrlsInText(firstLine(err))}`, { cause: err });
}

/** Closes a page context or the browser; a failure is a warning, never the run's error. */
async function closeQuietly(target, what) {
  try {
    await target.close();
  } catch (err) {
    console.warn(`  [WARN] Could not close the ${what}: ${sanitizeMessage(firstLine(err))}`);
  }
}

/**
 * Throws (INVALID_ARGUMENT) unless the run id is safe to use as a folder name.
 *
 * @param {string} runId
 */
export function assertValidRunId(runId) {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new CliError('INVALID_ARGUMENT', `Invalid runId "${runId}": must contain only alphanumeric characters, dashes, and underscores.`);
  }
}

/**
 * CSS injected into every page to ensure deterministic captures:
 * - Freezes all CSS animations and transitions
 * - Hides the typing caret
 * (maskSelectors are not handled here: they are painted as black boxes by
 * page.screenshot's `mask` option, see MASK_COLOR.)
 *
 * @returns {string} Injected CSS string
 */
export const MASK_COLOR = '#000000';

export function buildDeterministicStyle() {// this function mutes the css
  const css = `
    *, *::before, *::after {
      -webkit-transition: none !important;
      -moz-transition: none !important;
      -o-transition: none !important;
      -ms-transition: none !important;
      transition: none !important;
      -webkit-animation: none !important;
      -moz-animation: none !important;
      -o-animation: none !important;
      -ms-animation: none !important;
      animation: none !important;
      caret-color: transparent !important;
      scroll-behavior: auto !important;
    }
  `;// this is a custome block of css which is designed to block all the animations on a website .
  // this first line applies the css to each element of the webpage. * in css means all 

  return css;
}

/**
 * Fails fast, naming the offending entry, if a maskSelectors entry isn't a valid
 * Playwright selector (pseudo-elements such as ::after are not supported).
 *
 * @param {import('playwright').Page} page
 * @param {string[]} [maskSelectors]
 */
async function assertValidMaskSelectors(page, maskSelectors = []) {
  for (const [i, selector] of maskSelectors.entries()) {
    try {
      await page.locator(selector).count();
    } catch (err) {
      throw new CliError('CONFIG_INVALID', `maskSelectors[${i}] "${selector}" is not a valid selector: ${firstLine(err)}`, { cause: err });
    }
  }
}

/**
 * Collects a bounded set of DOM tokens (class/id/data attributes) used to link a
 * visual change to CSS/template changes in the branch-comparison report. This is
 * best-effort: a failure never breaks capture.
 *
 * @param {import('playwright').Page} page
 * @param {number} [max=4000]
 * @returns {Promise<string[]>}
 */
export async function collectDomTokens(page, max = 4000) {
  try {
    return await page.evaluate((limit) => {
      const tokens = new Set();
      const elements = document.querySelectorAll('*');
      for (let i = 0; i < elements.length && tokens.size < limit; i++) {
        const el = elements[i];
        const className = typeof el.className === 'string' ? el.className : el.className?.baseVal;
        if (className) {
          for (const part of String(className).split(/\s+/)) {
            if (part && tokens.size < limit) tokens.add(`.${part}`);
          }
        }
        if (el.id && tokens.size < limit) tokens.add(`#${el.id}`);
        for (const attr of ['data-testid', 'data-test-id', 'data-vrt-source']) {
          const value = el.getAttribute(attr);
          if (value && tokens.size < limit) tokens.add(`[${attr}="${value}"]`);
        }
      }
      return [...tokens];
    }, max);
  } catch {
    return [];
  }
}

/**
 * Captures screenshots for all configured routes and viewports.
 *
 * @param {object} config - Validated configuration object
 * @param {object} [options={}] - Execution options
 * @param {string} [options.runId] - Run ID folder name (defaults to "run_<timestamp>")
 * @param {string} [options.outputDir] - Base output directory (defaults to config.storageDir/runs)
 * @param {Function} [options.onProgress] - Callback invoked after each screenshot
 * @param {number} [options.navigationTimeout=30000] - Max ms for the page's load event (failing this aborts the capture)
 * @param {number} [options.networkIdleTimeout=10000] - Max ms to additionally wait for network idle (best effort)
 * @param {number} [options.settleMs=200] - Extra pause before the screenshot (for SPA rendering)
 * @param {string} [options.waitForSelector] - Wait for this element (visible) before capturing
 * @param {boolean} [options.scrollToBottom=false] - Scroll through the page first to trigger lazy loading
 * @param {boolean} [options.collectDomTokens=false] - Also record DOM tokens per snapshot (for code correlation)
 * @returns {Promise<Array<object>>} Array of captured snapshot results
 */
export async function captureScreenshots(config, options = {}) {
  const runId = options.runId || `run_${Date.now()}`;
  assertValidRunId(runId);
  const navigationTimeout = options.navigationTimeout ?? 30000;
  const networkIdleTimeout = options.networkIdleTimeout ?? 10000;
  const settleMs = options.settleMs ?? 200;
  const baseStorage = options.outputDir || path.resolve(process.cwd(), config.storageDir || 'storage', 'runs');
  const targetDir = path.resolve(baseStorage, runId);

  fs.mkdirSync(targetDir, { recursive: true });

  const deterministicCss = buildDeterministicStyle();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    throw toLaunchError(err);
  }
  const results = [];
  let masksChecked = false;

  try {
    for (const route of config.routes) {
      const fullUrl = `${config.baseUrl}${route}`;

      for (const viewport of config.viewports) {
        const context = await browser.newContext({
          viewport: {
            width: viewport.width,
            height: viewport.height
          },
          deviceScaleFactor: 1
        });

        const page = await context.newPage();

        try {
          // The load event is required: a page that can't load is a real failure.
          try {
            await page.goto(fullUrl, { waitUntil: 'load', timeout: navigationTimeout });
          } catch (navErr) {
            throw toNavigationError(navErr, fullUrl);
          }

          // Network idle is best effort. Pages with analytics beacons, long-polling or
          // websockets never go idle; for those, capture the already-loaded page.
          let networkIdle = true;
          try {
            await page.waitForLoadState('networkidle', { timeout: networkIdleTimeout });
          } catch (idleErr) {
            if (!(idleErr instanceof playwrightErrors.TimeoutError)) throw idleErr;
            networkIdle = false;
          }

          if (!masksChecked) {
            await assertValidMaskSelectors(page, config.maskSelectors);
            masksChecked = true;
          }

          // Scrolling through the page triggers lazy-loaded images and intersection
          // observers; return to the top so the full-page screenshot starts at 0.
          if (options.scrollToBottom) {
            await page.evaluate(async () => {
              const step = Math.max(200, window.innerHeight || 600);
              const height = document.body.scrollHeight || document.documentElement.scrollHeight;
              for (let y = 0; y < height; y += step) {
                window.scrollTo(0, y);
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
              window.scrollTo(0, 0);
            });
            await page.waitForTimeout(100); // let intersection observers fire
          }

          // SPAs often render their real content after the load event. An explicit
          // selector lets the caller wait for it instead of screenshotting a skeleton.
          if (options.waitForSelector) {
            try {
              await page.waitForSelector(options.waitForSelector, { state: 'visible', timeout: navigationTimeout });
            } catch (err) {
              throw new CliError('NAVIGATION_FAILED', `Timed out waiting for "${options.waitForSelector}" on ${redactUrl(fullUrl)}: ${firstLine(err)}`, { cause: err });
            }
          }

          // Inject deterministic styles to freeze animations and hide the caret
          await page.addStyleTag({ content: deterministicCss });

          // Brief pause to allow any synchronous style recalculation
          await page.waitForTimeout(settleMs);

          const tokens = options.collectDomTokens ? await collectDomTokens(page) : undefined;

          const filename = getSnapshotFilename(route, viewport.name);
          const filepath = path.join(targetDir, filename);

          // Full page capture. Masked elements are painted over with solid black boxes;
          // unlike hiding them with CSS this also covers canvases, iframes and elements
          // whose inline styles would override an injected rule.
          await page.screenshot({
            path: filepath,
            fullPage: true,
            mask: (config.maskSelectors || []).map((selector) => page.locator(selector)),
            maskColor: MASK_COLOR
          });

          const snapshotResult = {
            runId,
            route,
            viewport: viewport.name,
            width: viewport.width,
            height: viewport.height,
            filepath,
            filename,
            url: fullUrl,
            networkIdle,
            ...(tokens ? { tokens } : {})
          };

          results.push(snapshotResult);

          if (typeof options.onProgress === 'function') {
            options.onProgress(snapshotResult);
          }
        } finally {
          await closeQuietly(context, 'browser context');
        }
      }
    }
  } finally {
    await closeQuietly(browser, 'browser');
  }

  return results;
}
