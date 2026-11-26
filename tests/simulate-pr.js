#!/usr/bin/env node
/**
 * Standalone simulation of a pull request visual check.
 *
 * Creates a throwaway git repo with a base commit and a PR commit that changes a
 * CSS selector, runs `visual-ci compare-branches` with real Chromium, then posts
 * the generated report to a local fake GitHub/GitLab comment API twice (create +
 * update) so the sticky-comment behaviour can be seen end to end.
 *
 * Usage: node tests/simulate-pr.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const CLI = path.join(ROOT, 'src/cli/index.js');
const POSTER = path.join(ROOT, 'src/ci/postComment.js');

const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
const fail = (message) => { console.error(`[SIM FAIL] ${message}`); process.exit(1); };
/** Async spawn: the fake API server needs the parent event loop while the child runs. */
const runAsync = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (status) => resolve({ status, stdout, stderr }));
});
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});

async function fakeApi() {
  const notes = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      res.setHeader('content-type', 'application/json');
      res.setHeader('connection', 'close');
      if (req.method === 'GET') return res.end(JSON.stringify(notes));
      if (req.method === 'PATCH' || req.method === 'PUT') {
        const index = Number(req.url.split('/').pop()) - 1;
        notes[index] = { id: index + 1, body: payload.body };
        return res.end(JSON.stringify({ html_url: 'http://local/note', web_url: 'http://local/note' }));
      }
      notes.push({ id: notes.length + 1, body: payload.body });
      res.end(JSON.stringify({ html_url: 'http://local/note', web_url: 'http://local/note' }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, notes, close: () => new Promise((r) => server.close(r)) };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-sim-pr-'));
  const api = await fakeApi();
  const [portBase, portHead] = [await freePort(), await freePort()];
  try {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'sim@example.com']);
    git(dir, ['config', 'user.name', 'Simulation']);

    fs.writeFileSync(path.join(dir, 'app.js'), `
      const http = require('node:http');
      const fs = require('node:fs');
      const port = Number(process.env.PORT || process.env.DEMO_PORT || 3000);
      http.createServer((req, res) => {
        if (req.url === '/styles.css') {
          res.writeHead(200, { 'content-type': 'text/css' });
          return res.end(fs.readFileSync('styles.css', 'utf8'));
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head>' +
          '<body><main class="hero" id="app"><h1>Checkout</h1><button class="buy">Buy</button></main></body></html>');
      }).listen(port, '127.0.0.1');
    `);
    fs.writeFileSync(path.join(dir, 'styles.css'), '.hero { background: rgb(240, 240, 240); }\n');
    fs.writeFileSync(path.join(dir, 'visual.config.json'), JSON.stringify({
      baseUrl: 'http://127.0.0.1:1',
      routes: ['/'],
      viewports: [{ name: 'desktop', width: 320, height: 200 }, { name: 'mobile', width: 180, height: 200 }],
      threshold: 0.001,
      branchCompare: {
        baseRef: 'base', installCommand: '', startCommand: 'node app.js',
        portBase, portHead, waitOnPath: '/', startTimeoutMs: 15000,
        onRegression: 'warn'
      }
    }, null, 2));
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'base: light hero']);
    git(dir, ['branch', 'base']);

    // The PR: a visual change in CSS plus an unrelated docs change that must not be blamed.
    fs.writeFileSync(path.join(dir, 'styles.css'), '.hero { background: rgb(20, 90, 220); }\n.buy { color: white; }\n');
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), 'unrelated docs edit\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'PR: change hero background']);

    console.log('──────────────────────────────────────────────────────');
    console.log('  SIMULATED PULL REQUEST');
    console.log('  base: light hero  →  PR: blue hero + unrelated docs edit');
    console.log('──────────────────────────────────────────────────────\n');

    const run = spawnSync(process.execPath, [CLI, 'compare-branches', '-c', 'visual.config.json', '-r', 'sim_pr', '--json', 'result.json'], {
      cwd: dir, encoding: 'utf8', timeout: 120000
    });
    if (run.status !== 0) fail(`compare-branches exited ${run.status}\n${run.stdout}\n${run.stderr}`);
    console.log(run.stdout.trim().split('\n').filter((line) => line.includes('Changed') || line.includes('[SUCCESS]') || line.includes('[FAILURE]')).join('\n'));

    const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
    if (result.schema !== 'visual-branch-compare' || result.counts.total !== 2) fail('unexpected result schema/counts');
    console.log(`\n  Result: ${result.counts.changed}/${result.counts.total} snapshots changed`);
    for (const snapshot of result.snapshots) {
      const top = snapshot.suspects[0];
      console.log(`  - ${snapshot.route} @ ${snapshot.viewport}: ${snapshot.status} ${snapshot.mismatch_percentage}%` +
        (top ? ` → ${top.path}:${top.line} (${top.confidence}: ${top.reason})` : ' → no likely source'));
    }

    const reportPath = path.join(dir, result.run.report);
    const report = fs.readFileSync(reportPath, 'utf8');
    if (!report.includes('styles.css')) fail('report does not link the changed CSS file');
    // The raw git diff section may legitimately list it; the suspect section must not.
    if (report.includes('- `CHANGELOG.md` —')) fail('report blamed the unrelated docs file');

    const noteCounts = {};
    for (const [platform, env] of [
      ['github', { VRT_PLATFORM: 'github', GITHUB_REPOSITORY: 'demo/repo', GITHUB_PR_NUMBER: '42', GITHUB_API_URL: api.url, GITHUB_TOKEN: 'ghp_simulated' }],
      ['gitlab', { VRT_PLATFORM: 'gitlab', CI_PROJECT_ID: '99', CI_MERGE_REQUEST_IID: '17', CI_API_V4_URL: api.url, GL_TOKEN: 'glpat-simulated' }]
    ]) {
      api.notes.length = 0; // GitHub and GitLab are separate APIs; start each with an empty one
      for (const expected of ['created', 'updated']) {
        const out = await runAsync(process.execPath, [POSTER, 'result.json'], {
          cwd: dir, env: { ...process.env, ...env }
        });
        if (out.status !== 0) fail(`${platform} comment failed: ${out.stderr}`);
        if (!out.stdout.includes(expected)) fail(`${platform} comment was not ${expected}: ${out.stdout}`);
        console.log(`  ${platform} comment: ${out.stdout.trim()}`);
      }
      noteCounts[platform] = api.notes.length;
    }
    if (noteCounts.github !== 1 || noteCounts.gitlab !== 1) fail(`expected one sticky note per platform, got ${JSON.stringify(noteCounts)}`);
    if (!api.notes.every((n) => n.body.includes('<!-- visual-branch-compare -->'))) fail('sticky marker missing');

    console.log('\n  Report excerpt:');
    console.log(report.split('\n').slice(0, 16).map((line) => `  ${line}`).join('\n'));
    console.log('\n[SIM PASS] Two-branch visual check, code correlation and sticky comments all worked.');
  } finally {
    await api.close();
    try { git(dir, ['worktree', 'prune']); } catch { /* best effort */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => fail(String(err?.stack ?? err)));
