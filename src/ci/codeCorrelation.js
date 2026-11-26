import { execFileSync } from 'node:child_process';
import { getRouteSlug } from '../cli/naming.js';
import { toDisplayPath } from '../cli/display.js';

/**
 * Heuristic link between visual changes and code changes.
 *
 * This module never claims certainty: every suspect carries a reason and a
 * confidence level. It reads git diff output (no shell), extracts selector and
 * template tokens from the changed lines, and compares them with the DOM tokens
 * captured from the page that changed visually.
 */

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

/** A tiny glob matcher: ** crosses directories, * and ? do not. */
export function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i++; } else out += '[^/]*';
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`);
}

export function matchesAnyGlob(file, patterns = []) {
  return patterns.some((pattern) => globToRegExp(pattern).test(file));
}

/** Changed files with their added-line hunks, from a three-dot base...head diff. */
export function gitChangedFiles({ repoRoot, baseSha, headSha }) {
  const nameStatus = git(['diff', '--name-status', `${baseSha}...${headSha}`], repoRoot);
  const byPath = new Map();
  for (const line of nameStatus.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0]?.charAt(0) || 'M';
    const file = parts.length >= 3 ? parts[2] : parts[1]; // renames: old, new
    if (!file) continue;
    byPath.set(file, { path: file, status, hunks: [] });
  }

  const diff = git(['diff', '--unified=0', '--no-color', `${baseSha}...${headSha}`, '--'], repoRoot);
  let current = null;
  let newLine = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      current = byPath.get(line.slice(6).replace(/\t.*$/, '')) || null;
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      if (current) current.hunks.push({ start: newLine, lines: [] });
      continue;
    }
    if (!current || line.startsWith('diff --git') || line.startsWith('--- ') || line.startsWith('index ')) continue;
    if (line.startsWith('+')) {
      const hunk = current.hunks[current.hunks.length - 1];
      if (hunk) hunk.lines.push({ line: newLine, text: line.slice(1) });
      newLine++;
    } else if (line.startsWith(' ')) {
      newLine++;
    }
  }
  return [...byPath.values()];
}

const CSS_EXT = new Set(['.css', '.scss', '.sass', '.less', '.styl']);
const JS_EXT = new Set(['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx']);
const TEMPLATE_EXT = new Set(['.html', '.htm', '.ejs', '.hbs', '.mustache', '.jsx', '.tsx', '.vue', '.svelte', '.js', '.ts', '.mjs', '.cjs']);
const CONFIG_EXT = new Set(['.json', '.yaml', '.yml', '.toml']);
const STOPWORDS = new Set([
  'const', 'function', 'return', 'if', 'else', 'true', 'false', 'null', 'undefined',
  'new', 'await', 'async', 'import', 'export', 'from', 'class', 'extends', 'this',
  'let', 'var', 'for', 'while', 'switch', 'case', 'break', 'default', 'throw',
  'try', 'catch', 'finally', 'typeof', 'instanceof', 'string', 'number', 'boolean',
  'object', 'array', 'promise', 'void', 'yield', 'interface', 'type', 'returns'
]);

function compactColor(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (!hex) return text;
  let digits = hex[1];
  if (digits.length === 3) digits = digits.split('').map((c) => c + c).join('');
  const r = parseInt(digits.slice(0, 2), 16);
  const g = parseInt(digits.slice(2, 4), 16);
  const b = parseInt(digits.slice(4, 6), 16);
  return `rgb(${r},${g},${b})`;
}

/** File types whose changes can actually change a rendered page. */
export const RENDER_EXTENSIONS = new Set([
  ...CSS_EXT, ...TEMPLATE_EXT,
  '.json', '.yaml', '.yml', '.toml',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.ico'
]);

/**
 * True when at least one changed file could affect rendering. Used to skip an
 * expensive two-branch capture for docs/test-only PRs.
 */
export function hasRenderRelevantChanges(changedFiles = [], routeSources = {}) {
  const configured = Object.values(routeSources).flat();
  return changedFiles.some((file) => {
    // Test and docs files never change a rendered page, even when they are .js/.ts.
    if (/(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/i.test(file.path)) return false;
    if (matchesAnyGlob(file.path, configured)) return true;
    const base = file.path.split(/[\\/]/).pop() || '';
    if (base === 'visual.config.json' || base === 'package.json') return true;
    const dot = base.lastIndexOf('.');
    return dot !== -1 && RENDER_EXTENSIONS.has(base.slice(dot).toLowerCase());
  });
}

/** Extracts DOM-matching tokens and example lines from the added diff lines. */
export function extractSignals(file) {
  const ext = pathExt(file.path);
  const tokens = new Map(); // token -> first line where it was seen
  const add = (token, line) => {
    if (token && !tokens.has(token) && tokens.size < 600) tokens.set(token, line);
  };

  for (const hunk of file.hunks) {
    for (const entry of hunk.lines) {
      const text = entry.text;
      const line = entry.line;

      if (CSS_EXT.has(ext)) {
        for (const match of text.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) add(`.${match[1]}`, line);
        for (const match of text.matchAll(/#(-?[_a-zA-Z][\w-]*)/g)) add(`#${match[1]}`, line);
        for (const match of text.matchAll(/\[data-([\w-]+)/g)) add(`[data-${match[1]}]`, line);
        for (const match of text.matchAll(/--([\w-]+)\s*:\s*([^;}]+)/g)) {
          add(`var:--${match[1]}=${compactColor(match[2])}`, line);
          add(`id:${match[1]}`, line);
        }
        for (const match of text.matchAll(/@keyframes\s+([\w-]+)/g)) add(`keyframes:${match[1]}`, line);
        for (const match of text.matchAll(/(color|background|background-color|border-color|font-size|font-family|display|transform|opacity|width|height|margin|padding|gap)\s*:\s*([^;}]+)/gi)) {
          const property = match[1].toLowerCase();
          const value = compactColor(match[2]);
          add(`css:${property}=${value}`, line);
          add(`prop:${property}=${value}`, line);
        }
      }

      if (TEMPLATE_EXT.has(ext) || CSS_EXT.has(ext)) {
        for (const match of text.matchAll(/>([^<>{}]{3,120})</g)) add(`text:${match[1].trim()}`, line);
        for (const match of text.matchAll(/(?:class(?:Name)?|id|data-testid|data-test-id|data-vrt-source|data-state)\s*=\s*["'`]([^"'`]+)["'`]/g)) {
          for (const cls of match[1].split(/\s+/)) {
            if (!cls) continue;
            const attr = match[0].slice(0, match[0].indexOf('=')).trim();
            if (attr === 'id') add(`#${cls}`, line);
            else if (attr.startsWith('data-')) {
              add(`[${attr}="${cls}"]`, line);
              add(`state:${cls}`, line);
              add(`id:${cls}`, line);
            } else add(`.${cls}`, line);
          }
        }
      }

      if (JS_EXT.has(ext)) {
        // State-machine names, action strings and user-visible text all end up in
        // the DOM, so they are the strongest signal for logic that changes a page.
        for (const match of text.matchAll(/['"`]([^'"`\n]{4,120})['"`]/g)) {
          const value = match[1];
          add(`str:${value}`, line);
          add(`text:${value}`, line);
          add(`id:${value}`, line);
          add(`state:${value}`, line);
        }
        for (const match of text.matchAll(/[A-Za-z_$][\w$]{3,}/g)) {
          const word = match[0];
          if (STOPWORDS.has(word.toLowerCase())) continue;
          add(`id:${word}`, line);
          add(`state:${word}`, line);
        }
        for (const match of text.matchAll(/(?:from\s+|import\s*\(?\s*)['"]([^'"]+)['"]/g)) {
          add(`import:${match[1]}`, line);
          add(`file:${pathExtName(match[1])}`, line);
        }
      }

      if (CONFIG_EXT.has(ext)) {
        for (const match of text.matchAll(/["']([A-Za-z][\w-]{2,})["']\s*:/g)) add(`cfg:${match[1]}`, line);
        for (const match of text.matchAll(/:\s*["']([^"']{3,80})["']/g)) {
          add(`str:${match[1]}`, line);
          add(`id:${match[1]}`, line);
        }
      }
    }
  }
  add(`file:${pathExtName(file.path)}`, file.hunks[0]?.lines[0]?.line ?? null);
  return tokens;
}

function pathExtName(file) {
  const base = file.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return (dot === -1 ? base : base.slice(0, dot)).toLowerCase();
}

function pathExt(file) {
  const base = file.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot).toLowerCase();
}

function reasonFor(scoreParts, matched) {
  const reasons = [...scoreParts];
  if (matched.length) reasons.push(`changed ${matched.slice(0, 3).join(', ')}${matched.length > 3 ? '…' : ''} appears on this page`);
  return reasons.join('; ');
}

/**
 * Adds ranked `suspects` to changed snapshots.
 *
 * @param {object} options
 * @param {object[]} options.results - Branch comparison records
 * @param {object[]} options.changedFiles - From gitChangedFiles()
 * @param {object} [options.routeSources={}] - route -> glob patterns from config
 * @param {string[]} [options.ignorePaths=[]] - globs to skip entirely
 * @param {number} [options.maxPerSnapshot=5]
 * @returns {{ results: object[], fileImpacts: object[] }}
 */
export function correlateChanges({ results, changedFiles, routeSources = {}, ignorePaths = [], maxPerSnapshot = 5 }) {
  const fileImpacts = new Map();
  // Module graph: which files import a changed module. A state helper imported by a
  // route's page is often the real cause even when it contains no class names.
  const importers = new Map();
  for (const file of changedFiles) {
    for (const token of extractSignals(file).keys()) {
      if (!token.startsWith('import:')) continue;
      const name = pathExtName(token.slice(7));
      if (!importers.has(name)) importers.set(name, new Set());
      importers.get(name).add(file.path);
    }
  }

  for (const result of results) {
    if (result.status !== 'DIFF' && result.status !== 'MISSING_BASE') {
      result.suspects = [];
      continue;
    }
    const domTokens = new Set(result.tokens || []);
    const slug = getRouteSlug(result.route);
    const routePatterns = [...(routeSources[result.route] || []), ...(routeSources['*'] || [])];
    const suspects = [];

    for (const file of changedFiles) {
      if (matchesAnyGlob(file.path, ignorePaths)) continue;
      const signals = extractSignals(file);
      const matched = [...signals.keys()].filter((token) => domTokens.has(token));
      const scoreParts = [];
      let score = 0;
      let line = file.hunks[0]?.lines[0]?.line ?? null;

      if (matchesAnyGlob(file.path, routePatterns)) {
        score += 60;
        scoreParts.push(`configured source for ${result.route}`);
      }
      if (slug && file.path.toLowerCase().includes(slug.toLowerCase())) {
        score += 25;
        scoreParts.push(`path matches route "${result.route}"`);
      }
      if (matched.length) {
        score += Math.min(40, matched.length * 12);
        for (const token of matched) {
          const seen = signals.get(token);
          if (seen !== null && seen !== undefined && (line === null || seen < line)) line = seen;
        }
      }
      const stateMatches = matched.filter((t) => /^(id|state|str|text|cfg):/.test(t));
      if (stateMatches.length) {
        score += Math.min(15, stateMatches.length * 5);
        scoreParts.push('state/action string appears on this page');
      }
      const styleMatches = matched.filter((t) => /^(css|prop|var|keyframes):/.test(t));
      if (styleMatches.length) {
        score += Math.min(15, styleMatches.length * 5);
        scoreParts.push('computed style or custom property matches');
      }
      const usedByRoute = [...(importers.get(pathExtName(file.path)) || [])]
        .some((importerPath) => matchesAnyGlob(importerPath, routePatterns));
      if (usedByRoute) {
        score += 15;
        scoreParts.push('imported by a changed route source');
      }

      if (score < 10) continue;
      const confidence = score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low';
      suspects.push({
        path: toDisplayPath(file.path),
        line,
        reason: reasonFor(scoreParts, matched),
        evidence: matched.length ? `tokens: ${matched.slice(0, 6).join(', ')}` : 'route/path or import mapping',
        confidence,
        score,
        change: file.status,
        diff: file.hunks.filter((hunk) => hunk.lines.length).slice(0, 3).map((hunk) => ({
          start: hunk.start,
          lines: hunk.lines.slice(0, 10).map((entry) => entry.text)
        }))
      });
      const impact = fileImpacts.get(file.path) || { path: toDisplayPath(file.path), snapshots: [], score: 0 };
      impact.snapshots.push(`${result.route} @ ${result.viewport}`);
      impact.score = Math.max(impact.score, score);
      fileImpacts.set(file.path, impact);
    }

    suspects.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    result.suspects = suspects.slice(0, maxPerSnapshot);
  }

  return {
    results,
    fileImpacts: [...fileImpacts.values()].sort((a, b) => b.score - a.score)
  };
}
