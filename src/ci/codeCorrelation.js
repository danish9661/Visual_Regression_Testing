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
const TEMPLATE_EXT = new Set(['.html', '.ejs', '.hbs', '.mustache', '.jsx', '.tsx', '.vue', '.svelte', '.js', '.ts', '.mjs', '.cjs']);

/** Extracts DOM-matching tokens and example lines from the added diff lines. */
export function extractSignals(file) {
  const ext = pathExt(file.path);
  const tokens = new Map(); // token -> first line where it was seen
  const add = (token, line) => { if (token && !tokens.has(token)) tokens.set(token, line); };

  for (const hunk of file.hunks) {
    for (const entry of hunk.lines) {
      const text = entry.text;
      if (CSS_EXT.has(ext)) {
        for (const match of text.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) add(`.${match[1]}`, entry.line);
        for (const match of text.matchAll(/#(-?[_a-zA-Z][\w-]*)/g)) add(`#${match[1]}`, entry.line);
        for (const match of text.matchAll(/\[data-([\w-]+)/g)) add(`[data-${match[1]}]`, entry.line);
      }
      if (TEMPLATE_EXT.has(ext) || CSS_EXT.has(ext)) {
        for (const match of text.matchAll(/(?:class(?:Name)?|id|data-testid|data-test-id|data-vrt-source)\s*=\s*["'`]([^"'`]+)["'`]/g)) {
          for (const cls of match[1].split(/\s+/)) {
            if (!cls) continue;
            const attr = match[0].slice(0, match[0].indexOf('=')).trim();
            if (attr === 'id') add(`#${cls}`, entry.line);
            else if (attr.startsWith('data-')) add(`[${attr}="${cls}"]`, entry.line);
            else add(`.${cls}`, entry.line);
          }
        }
      }
    }
  }
  return tokens;
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
        score += Math.min(30, matched.length * 10);
        for (const token of matched) {
          const seen = signals.get(token);
          if (seen !== null && seen !== undefined && (line === null || seen < line)) line = seen;
        }
      }

      if (score < 10) continue;
      const confidence = score >= 40 ? 'high' : score >= 20 ? 'medium' : 'low';
      suspects.push({
        path: toDisplayPath(file.path),
        line,
        reason: reasonFor(scoreParts, matched),
        evidence: matched.length ? `tokens: ${matched.slice(0, 5).join(', ')}` : 'route/path mapping',
        confidence,
        score,
        change: file.status
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
