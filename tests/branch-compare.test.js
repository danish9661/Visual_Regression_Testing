import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';

import { validateBranchCompare, validateConfig } from '../src/cli/config.js';
import { compareBranchSnapshots, buildBranchCompareResult } from '../src/cli/branchCompare.js';
import {
  globToRegExp, matchesAnyGlob, extractSignals, correlateChanges, hasRenderRelevantChanges
} from '../src/ci/codeCorrelation.js';
import {
  generateBranchReportMarkdown, generateJUnit, writeBranchReport, BRANCH_MARKER
} from '../src/ci/branchReport.js';

const CLI = path.resolve('src/cli/index.js');
const ORIGINAL_CSS = '.hero { color: rgb(10, 10, 10); }\n';

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 90000 });
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
function solidPng(file, r, g, b) {
  const png = new PNG({ width: 8, height: 8 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
  }
  fs.writeFileSync(file, PNG.sync.write(png));
}

describe('branchCompare configuration', () => {
  it('defaults to safe values and keeps the block optional', () => {
    expect(validateBranchCompare(undefined)).toBeNull();
    const bc = validateBranchCompare({});
    expect(bc).toMatchObject({
      baseRef: 'origin/main',
      baseStrategy: 'merge-base',
      installCommand: 'npm ci',
      startCommand: 'npm start',
      portBase: 4100,
      portHead: 4101,
      onRegression: 'fail'
    });
    expect(bc.report.comment).toBe(true);
    expect(bc.report.maxRows).toBe(25);
    expect(bc.stabilityCheck).toBe(false);
    expect(bc.skipWhenNoRenderChanges).toBe(false);
    expect(bc.routeThresholds).toEqual({});
    expect(bc.settleMs).toBe(200);
    expect(bc.waitForSelector).toBeNull();
    expect(bc.scrollToBottom).toBe(false);
  });

  it('validates the new improvement settings', () => {
    const bc = validateBranchCompare({
      stabilityCheck: true, skipWhenNoRenderChanges: true,
      routeThresholds: { '/pricing': 2, about: 0.5 },
      settleMs: 500, waitForSelector: '.app-ready', scrollToBottom: true
    });
    expect(bc.stabilityCheck).toBe(true);
    expect(bc.skipWhenNoRenderChanges).toBe(true);
    expect(bc.routeThresholds).toEqual({ '/pricing': 2, '/about': 0.5 });
    expect(bc.settleMs).toBe(500);
    expect(bc.waitForSelector).toBe('.app-ready');
    expect(bc.scrollToBottom).toBe(true);
    expect(() => validateBranchCompare({ routeThresholds: { '/': 101 } })).toThrow(/between 0 and 100/);
    expect(() => validateBranchCompare({ stabilityCheck: 'yes' })).toThrow(/boolean/);
  });

  it('is included in a validated config and rejects unsafe values', () => {
    const config = validateConfig({
      baseUrl: 'http://127.0.0.1:3000',
      routes: ['/'],
      viewports: [{ name: 'desktop', width: 100, height: 100 }],
      branchCompare: { baseRef: 'origin/main', startCommand: 'node app.js', installCommand: '', portBase: 5000, portHead: 5001 }
    });
    expect(config.branchCompare.startCommand).toBe('node app.js');
    expect(() => validateBranchCompare({ baseRef: '--upload-pack=evil' })).toThrow(/safe git ref/);
    expect(() => validateBranchCompare({ baseStrategy: 'latest' })).toThrow(/merge-base/);
    expect(() => validateBranchCompare({ portBase: 80, portHead: 80 })).toThrow(/different/);
    expect(() => validateBranchCompare({ onRegression: 'ignore' })).toThrow(/fail.*warn/);
  });
});

describe('branch snapshot diffing', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-diff-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('reports MATCH, DIFF and MISSING_BASE and writes a red diff image', () => {
    const baseDir = path.join(dir, 'base');
    const headDir = path.join(dir, 'head');
    fs.mkdirSync(baseDir); fs.mkdirSync(headDir);
    const snap = (route, viewport, filepath) => ({ route, viewport, filepath, tokens: [] });

    solidPng(path.join(baseDir, 'a.png'), 10, 10, 10);
    solidPng(path.join(headDir, 'a.png'), 10, 10, 10);
    solidPng(path.join(baseDir, 'b.png'), 10, 10, 10);
    solidPng(path.join(headDir, 'b.png'), 250, 10, 10);
    solidPng(path.join(headDir, 'c.png'), 10, 10, 10);

    const results = compareBranchSnapshots({
      baseSnapshots: [snap('/', 'desktop', path.join(baseDir, 'a.png')), snap('/b', 'desktop', path.join(baseDir, 'b.png'))],
      headSnapshots: [
        snap('/', 'desktop', path.join(headDir, 'a.png')),
        snap('/b', 'desktop', path.join(headDir, 'b.png')),
        snap('/c', 'desktop', path.join(headDir, 'c.png'))
      ],
      diffDir: path.join(dir, 'diffs'),
      allowedThresholdRatio: 0.001
    });

    expect(results.map((r) => r.status)).toEqual(['MATCH', 'DIFF', 'MISSING_BASE']);
    expect(results[0].mismatchPercentage).toBe(0);
    expect(results[1].mismatchPercentage).toBeGreaterThan(0);
    expect(fs.existsSync(results[1].diffPath)).toBe(true);
    const diff = PNG.sync.read(fs.readFileSync(results[1].diffPath));
    expect(diff.data.some((value, i) => i % 4 === 0 && value === 255)).toBe(true);
    expect(results[2].basePath).toBeNull();
  });

  it('builds a versioned result with relative paths and change counts', () => {
    const result = buildBranchCompareResult({
      runId: 'branch_1',
      baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
      baseRef: 'main', headRef: 'HEAD',
      results: [{
        route: '/', viewport: 'desktop', status: 'DIFF', mismatchPercentage: 3.42,
        basePath: path.join(process.cwd(), 'storage', 'base.png'),
        headPath: path.join(process.cwd(), 'storage', 'head.png'),
        diffPath: path.join(process.cwd(), 'storage', 'diff.png'), suspects: []
      }]
    });
    expect(result.schema).toBe('visual-branch-compare');
    expect(result.version).toBe(1);
    expect(result.counts).toEqual({ total: 1, matched: 0, changed: 1 });
    expect(result.snapshots[0].suspects).toEqual([]);
    expect(result.snapshots[0].base).not.toMatch(/^\//);
  });

  it('honours per-route thresholds', () => {
    const baseDir = path.join(dir, 'tbase');
    const headDir = path.join(dir, 'thead');
    fs.mkdirSync(baseDir); fs.mkdirSync(headDir);
    solidPng(path.join(baseDir, 'a.png'), 10, 10, 10);
    solidPng(path.join(headDir, 'a.png'), 200, 10, 10);
    const base = [{ route: '/', viewport: 'desktop', filepath: path.join(baseDir, 'a.png') }];
    const head = [{ route: '/', viewport: 'desktop', filepath: path.join(headDir, 'a.png') }];
    const strict = compareBranchSnapshots({ baseSnapshots: base, headSnapshots: head, diffDir: path.join(dir, 'd1'), allowedThresholdRatio: 0.001 });
    const loose = compareBranchSnapshots({
      baseSnapshots: base, headSnapshots: head, diffDir: path.join(dir, 'd2'),
      allowedThresholdRatio: 0.001, routeThresholds: { '/': 100 }
    });
    expect(strict[0].status).toBe('DIFF');
    expect(loose[0].status).toBe('MATCH');
    expect(loose[0].thresholdPercent).toBe(100);
  });

  it('filters a difference that does not repeat in the stability capture', () => {
    const baseDir = path.join(dir, 'sbase');
    const headDir = path.join(dir, 'shead');
    const repeatDir = path.join(dir, 'srepeat');
    fs.mkdirSync(baseDir); fs.mkdirSync(headDir); fs.mkdirSync(repeatDir);
    solidPng(path.join(baseDir, 'a.png'), 10, 10, 10);
    solidPng(path.join(headDir, 'a.png'), 250, 10, 10);
    // The second render of each branch is identical, so the change was noise.
    solidPng(path.join(repeatDir, 'base.png'), 10, 10, 10);
    solidPng(path.join(repeatDir, 'head.png'), 10, 10, 10);
    const snap = (route, viewport, filepath) => ({ route, viewport, filepath, tokens: [] });
    const results = compareBranchSnapshots({
      baseSnapshots: [snap('/', 'desktop', path.join(baseDir, 'a.png'))],
      headSnapshots: [snap('/', 'desktop', path.join(headDir, 'a.png'))],
      repeatBaseSnapshots: [snap('/', 'desktop', path.join(repeatDir, 'base.png'))],
      repeatHeadSnapshots: [snap('/', 'desktop', path.join(repeatDir, 'head.png'))],
      diffDir: path.join(dir, 'sdiff'),
      allowedThresholdRatio: 0.001
    });
    expect(results[0].status).toBe('MATCH');
    expect(results[0].noiseFiltered).toBe(true);
    expect(results[0].repeatMismatchPercentage).toBe(0);
  });
});

describe('render-relevance detection', () => {
  it('skips docs-only changes but not CSS, config or mapped sources', () => {
    const file = (path) => ({ path, status: 'M' });
    expect(hasRenderRelevantChanges([file('README.md'), file('tests/x.test.js')])).toBe(false);
    expect(hasRenderRelevantChanges([file('src/a.css')])).toBe(true);
    expect(hasRenderRelevantChanges([file('visual.config.json')])).toBe(true);
    expect(hasRenderRelevantChanges([file('docs/a.md')], { '/': ['docs/a.md'] })).toBe(true);
  });
});

describe('code correlation heuristics', () => {
  it('matches globs with ** and * without crossing directories', () => {
    expect(globToRegExp('src/**/*.css').test('src/a/b.css')).toBe(true);
    expect(globToRegExp('src/*.css').test('src/a/b.css')).toBe(false);
    expect(matchesAnyGlob('src/pages/index.jsx', ['src/pages/index.*'])).toBe(true);
  });

  it('extracts CSS selectors from added diff lines', () => {
    const tokens = extractSignals({
      path: 'styles.css',
      hunks: [{ start: 7, lines: [{ line: 7, text: '.hero { color: red; }' }] }]
    });
    expect(tokens.get('.hero')).toBe(7);
  });

  it('extracts JS state-machine actions and visible text', () => {
    const tokens = extractSignals({
      path: 'src/state/checkout.js',
      hunks: [{
        start: 12,
        lines: [
          { line: 12, text: "dispatch({ type: 'CHECKOUT_FAILED' });" },
          { line: 13, text: '<div className="error-banner">Payment failed</div>' }
        ]
      }]
    });
    const keys = [...tokens.keys()];
    expect(keys).toContain('id:CHECKOUT_FAILED');
    expect(keys).toContain('state:CHECKOUT_FAILED');
    expect(keys).toContain('.error-banner');
    expect(keys).toContain('text:Payment failed');
  });

  it('normalises CSS colours and custom properties for matching computed styles', () => {
    const tokens = extractSignals({
      path: 'theme.css',
      hunks: [{
        start: 1,
        lines: [
          { line: 1, text: '--primary: #ff0000;' },
          { line: 2, text: '.btn { color: #fff; }' }
        ]
      }]
    });
    expect(tokens.get('var:--primary=rgb(255,0,0)')).toBe(1);
    expect(tokens.has('css:color=rgb(255,255,255)')).toBe(true);
  });

  it('ranks changed files by selector overlap and route mapping', () => {
    const results = [{
      route: '/', viewport: 'desktop', status: 'DIFF', mismatchPercentage: 5,
      tokens: ['.hero', '#app']
    }, {
      route: '/about', viewport: 'desktop', status: 'MATCH', mismatchPercentage: 0, tokens: []
    }];
    const changedFiles = [
      { path: 'styles.css', status: 'M', hunks: [{ start: 3, lines: [{ line: 3, text: '.hero { color: blue; }' }] }] },
      { path: 'README.md', status: 'M', hunks: [{ start: 1, lines: [{ line: 1, text: 'readme' }] }] }
    ];
    const { results: out, fileImpacts } = correlateChanges({
      results, changedFiles,
      routeSources: { '/': ['layout.html'] },
      ignorePaths: []
    });
    expect(out[0].suspects[0].path).toBe('styles.css');
    expect(out[0].suspects[0].line).toBe(3);
    expect(out[0].suspects[0].evidence).toContain('.hero');
    expect(out[0].suspects[0].diff[0].lines[0]).toContain('.hero { color: blue; }');
    expect(out[0].suspects.some((s) => s.path === 'README.md')).toBe(false);
    expect(out[1].suspects).toEqual([]);
    expect(fileImpacts[0].snapshots).toEqual(['/ @ desktop']);
  });

  it('respects ignorePaths and reports no suspect when nothing matches', () => {
    const results = [{ route: '/', viewport: 'desktop', status: 'DIFF', tokens: ['.hero'] }];
    const changedFiles = [{ path: 'docs/readme.md', status: 'M', hunks: [] }];
    expect(correlateChanges({ results, changedFiles }).results[0].suspects).toEqual([]);
    expect(correlateChanges({ results, changedFiles, ignorePaths: ['docs/**'] }).fileImpacts).toEqual([]);
  });
});

describe('branch comparison report', () => {
  const result = buildBranchCompareResult({
    runId: 'branch_1', baseSha: 'abcdef1234', headSha: '1234abcdef',
    baseRef: 'main', headRef: 'feature', exitCode: 1,
    results: [{
      route: '/', viewport: 'desktop', status: 'DIFF', mismatchPercentage: 3.42,
      basePath: 'runs/base.png', headPath: 'runs/head.png', diffPath: 'runs/diff.png',
      suspects: [{
        path: 'src/styles.css', line: 12, reason: 'changed .hero appears on this page', confidence: 'high', score: 70,
        diff: [{ start: 12, lines: ['- .hero { color: black; }', '+ .hero { color: blue; }'] }]
      }]
    }]
  });

  it('produces a sticky Markdown report linking visuals and code', () => {
    const md = generateBranchReportMarkdown({
      result,
      fileImpacts: [{ path: 'src/styles.css', snapshots: ['/ @ desktop'], score: 70 }],
      diffText: 'diff --git a/src/styles.css b/src/styles.css\n+ .hero { color: blue; }'
    });
    expect(md.startsWith(BRANCH_MARKER)).toBe(true);
    expect(md).toContain('3.42%');
    expect(md).toContain('src/styles.css:12');
    expect(md).toContain('[before](<runs/base.png>)');
    expect(md).toContain('```diff');
    expect(md).toContain('+ .hero { color: blue; }');
    expect(md).toContain('<details><summary>Full git diff');
    expect(md).toContain('heuristic matches');
  });

  it('produces JUnit failures only for changed snapshots', () => {
    const xml = generateJUnit({ result });
    expect(xml).toContain('<testsuite name="visual-branch-compare" tests="1" failures="1"');
    expect(xml).toContain('<failure message=');
  });

  it('writes the report file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-report-'));
    try {
      const { reportPath } = writeBranchReport('# report', { outputDir: dir, stepSummary: false });
      expect(fs.readFileSync(reportPath, 'utf8')).toBe('# report');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('visual-ci compare-branches (end to end)', () => {
  let dir;
  let portBase;
  let portHead;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-branches-'));
    portBase = await freePort();
    portHead = await freePort();
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(dir, 'app.js'), `
      const http = require('node:http');
      const fs = require('node:fs');
      const port = Number(process.env.PORT || process.env.DEMO_PORT || 3000);
      http.createServer((req, res) => {
        if (req.url === '/styles.css') {
          res.writeHead(200, { 'content-type': 'text/css' });
          res.end(fs.readFileSync('styles.css', 'utf8'));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head>' +
          '<body><div class="hero" id="app">Hello</div></body></html>');
      }).listen(port, '127.0.0.1');
    `);
    fs.writeFileSync(path.join(dir, 'styles.css'), ORIGINAL_CSS);
    fs.writeFileSync(path.join(dir, 'visual.config.json'), JSON.stringify({
      baseUrl: 'http://127.0.0.1:1',
      routes: ['/'],
      viewports: [{ name: 'desktop', width: 200, height: 120 }],
      threshold: 0.001,
      branchCompare: {
        baseRef: 'base',
        installCommand: '',
        startCommand: 'node app.js',
        portBase,
        portHead,
        waitOnPath: '/',
        startTimeoutMs: 15000,
        onRegression: 'fail'
      }
    }, null, 2));
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'base']);
    git(dir, ['branch', 'base']);
    fs.writeFileSync(path.join(dir, 'styles.css'), '.hero { color: rgb(220, 20, 20); }\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'change hero colour']);
  });

  afterEach(() => {
    // Detached worktrees are removed by the command; force-clean in case a test failed early.
    try { git(dir, ['worktree', 'prune']); } catch { /* best effort */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('detects the visual change and links it to the changed CSS file', () => {
    const resultFile = path.join(dir, 'result.json');
    const run = runCli(dir, [
      'compare-branches', '-c', 'visual.config.json', '-r', 'branch_e2e', '--json', 'result.json'
    ]);
    expect(run.status, run.stdout + '\n' + run.stderr).toBe(1);

    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    expect(result.schema).toBe('visual-branch-compare');
    expect(result.counts.total).toBe(1);
    expect(result.counts.changed).toBe(1);
    expect(result.snapshots[0].status).toBe('DIFF');
    expect(result.snapshots[0].mismatch_percentage).toBeGreaterThan(0);
    expect(result.snapshots[0].suspects[0].path).toBe('styles.css');
    expect(result.snapshots[0].suspects[0].evidence).toContain('.hero');
    expect(result.snapshots[0].attribute_changes.some((c) => c.attribute === 'style.color')).toBe(true);

    const runDir = path.join(dir, 'storage', 'runs', 'branch_e2e', 'branch-compare');
    expect(fs.existsSync(path.join(runDir, 'diffs', 'index-desktop-diff.png'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'report.md'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'junit.xml'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'base', 'index-desktop.png'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'head', 'index-desktop.png'))).toBe(true);
    expect(fs.readFileSync(path.join(runDir, 'report.md'), 'utf8')).toContain('DOM / style attribute differences');
  }, 120000);

  it('warn-only policy still reports the change but exits 0', () => {
    const run = runCli(dir, [
      'compare-branches', '-c', 'visual.config.json', '-r', 'branch_warn',
      '--on-regression', 'warn', '--no-report', '--json', 'warn.json'
    ]);
    expect(run.status, run.stdout + '\n' + run.stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(path.join(dir, 'warn.json'), 'utf8'));
    expect(result.status).toBe('failed');
    expect(result.exit_code).toBe(0);
    expect(result.counts.changed).toBe(1);
  }, 120000);

  it('records the repeat mismatch when stability checking is enabled', () => {
    const run = runCli(dir, [
      'compare-branches', '-c', 'visual.config.json', '-r', 'branch_stable',
      '--stability-check', '--no-report', '--json', 'stable.json'
    ]);
    expect(run.status, run.stdout + '\n' + run.stderr).toBe(1);
    const result = JSON.parse(fs.readFileSync(path.join(dir, 'stable.json'), 'utf8'));
    expect(result.snapshots[0].repeat_mismatch_percentage).toBeGreaterThan(0);
    expect(result.snapshots[0].noise_filtered).toBe(false);
    const runDir = path.join(dir, 'storage', 'runs', 'branch_stable', 'branch-compare');
    expect(fs.existsSync(path.join(runDir, 'base2', 'index-desktop.png'))).toBe(true);
  }, 120000);

  it('skips capture when only docs changed', () => {
    // Revert the CSS so the head differs from base only by a docs file.
    fs.writeFileSync(path.join(dir, 'styles.css'), ORIGINAL_CSS);
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), 'docs only\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'docs only']);

    const run = runCli(dir, [
      'compare-branches', '-c', 'visual.config.json', '-r', 'branch_skip',
      '--skip-no-render-changes', '--no-report', '--json', 'skip.json'
    ]);
    expect(run.status, run.stdout + '\n' + run.stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(path.join(dir, 'skip.json'), 'utf8'));
    expect(result.skipped).toBe(true);
    expect(result.status).toBe('skipped');
    expect(result.counts.changed).toBe(0);
    expect(fs.existsSync(path.join(dir, 'storage', 'runs', 'branch_skip', 'branch-compare', 'base'))).toBe(false);
  }, 120000);

  it('links a JS state-machine change to the visual change', () => {
    fs.writeFileSync(path.join(dir, 'styles.css'), ORIGINAL_CSS);
    fs.writeFileSync(path.join(dir, 'app.js'), `
      const http = require('node:http');
      const port = Number(process.env.PORT || process.env.DEMO_PORT || 3000);
      http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><body><div id="app"></div><script>' +
          'const d = document.getElementById("app");' +
          'd.className = "state-error"; d.dataset.state = "failed";' +
          'd.textContent = "Payment failed";' +
          '</script></body></html>');
      }).listen(port, '127.0.0.1');
    `);
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'PR: flip checkout state machine']);

    const run = runCli(dir, [
      'compare-branches', '-c', 'visual.config.json', '-r', 'branch_state', '--json', 'state.json'
    ]);
    expect(run.status, run.stdout + '\n' + run.stderr).toBe(1);
    const result = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    expect(result.counts.changed).toBe(1);
    const suspect = result.snapshots[0].suspects.find((s) => s.path === 'app.js');
    expect(suspect).toBeTruthy();
    expect(suspect.evidence).toMatch(/state:failed|text:Payment failed/);
    expect(suspect.diff[0].lines.join('\n')).toContain('Payment failed');
    const report = fs.readFileSync(path.join(dir, 'storage', 'runs', 'branch_state', 'branch-compare', 'report.md'), 'utf8');
    expect(report).toContain('```diff');
    expect(report).toContain('Payment failed');
  }, 120000);
});
