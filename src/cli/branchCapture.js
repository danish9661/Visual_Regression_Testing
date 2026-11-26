import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { CliError } from './errors.js';
import { captureScreenshots } from './capture.js';
import { redactUrl } from './display.js';
import { sanitizeMessage } from './result.js';

/**
 * Materializes two git worktrees, serves each branch on its own port and captures
 * deterministic screenshots of both. Used by `visual-ci compare-branches`.
 *
 * The CI checkout is never switched: both revisions are attached with
 * `git worktree add --detach` into a temporary directory, which is removed afterwards.
 */

const MAX_LOG_CHARS = 20000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs git without a shell; refs are validated by config before they get here. */
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (err) {
    const detail = String(err.stderr || err.message || err).split('\n')[0];
    throw new CliError('GIT_FAILED', `git ${args.join(' ')} failed: ${sanitizeMessage(detail)}`, { cause: err });
  }
}

/**
 * Resolves the two commits to compare. `merge-base` (default) compares against what
 * the head actually forked from; `tip` compares against the base ref's current tip.
 *
 * @returns {{ baseSha: string, headSha: string, baseRef: string, headRef: string, repoRoot: string }}
 */
export function resolveBranchRefs({ repoRoot, baseRef = 'origin/main', headRef = 'HEAD', baseStrategy = 'merge-base' }) {
  const baseTip = git(['rev-parse', '--verify', `${baseRef}^{commit}`], repoRoot);
  const headSha = git(['rev-parse', '--verify', `${headRef}^{commit}`], repoRoot);
  const baseSha = baseStrategy === 'tip' ? baseTip : git(['merge-base', headSha, baseTip], repoRoot);
  return { baseSha, headSha, baseRef, headRef, repoRoot };
}

/** Adds detached worktrees for both commits and returns a cleanup function. */
export function createWorktrees({ repoRoot, baseSha, headSha, tempRoot }) {
  const baseDir = path.join(tempRoot, 'base');
  const headDir = path.join(tempRoot, 'head');
  const created = [];
  try {
    git(['worktree', 'add', '--detach', baseDir, baseSha], repoRoot);
    created.push(baseDir);
    git(['worktree', 'add', '--detach', headDir, headSha], repoRoot);
    created.push(headDir);
  } catch (err) {
    for (const dir of created.reverse()) {
      try { git(['worktree', 'remove', '--force', dir], repoRoot); } catch { /* best effort */ }
    }
    throw err;
  }
  return {
    baseDir,
    headDir,
    cleanup() {
      for (const dir of [headDir, baseDir]) {
        try { git(['worktree', 'remove', '--force', dir], repoRoot); } catch { /* best effort */ }
      }
    }
  };
}

/** Runs an install/start command in a worktree, returning a promise. */
function runCommand(command, cwd, env, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
    let log = '';
    const collect = (chunk) => {
      log = (log + chunk.toString()).slice(-MAX_LOG_CHARS);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new CliError('APP_START_FAILED', `${label} could not start: ${sanitizeMessage(err.message)}`, { cause: err }));
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      resolve({ code, log });
    });
  });
}

/** Links an existing node_modules folder when no install command was configured. */
function linkDependencies(dir, source) {
  if (!source || !fs.existsSync(source)) return;
  const target = path.join(dir, 'node_modules');
  if (!fs.existsSync(target)) {
    try { fs.symlinkSync(source, target, 'junction'); } catch { /* the app may not need it */ }
  }
}

async function isReady(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 3000));
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts one branch's app and waits until its waitOnPath answers.
 * Returns the URL and a stop() that terminates the whole process group.
 */
export async function startApp({ cwd, command, port, waitOnPath = '/', timeoutMs = 60000, installCommand = '', nodeModulesSource = null, label = 'app' }) {
  if (installCommand) {
    const installed = await runCommand(installCommand, cwd, process.env, `${label} install`);
    if (installed.code !== 0) {
      throw new CliError('APP_START_FAILED', `${label} install command failed (exit ${installed.code}): ${sanitizeMessage(installed.log.slice(-2000))}`);
    }
  } else {
    linkDependencies(cwd, nodeModulesSource);
  }

  const child = spawn(command, {
    cwd,
    shell: true,
    env: { ...process.env, PORT: String(port), DEMO_PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  });
  let log = '';
  const collect = (chunk) => { log = (log + chunk.toString()).slice(-MAX_LOG_CHARS); };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  const url = `http://127.0.0.1:${port}${waitOnPath}`;
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  child.once('exit', () => { exited = true; });

  try {
    while (Date.now() < deadline) {
      if (exited) {
        throw new CliError('APP_START_FAILED', `${label} exited before it was ready: ${sanitizeMessage(log.slice(-2000))}`);
      }
      if (await isReady(url, timeoutMs)) {
        return {
          url,
          log,
          stop() { stopChild(child); }
        };
      }
      await sleep(250);
    }
    throw new CliError('APP_START_FAILED', `${label} did not answer at ${redactUrl(url)} within ${timeoutMs}ms: ${sanitizeMessage(log.slice(-2000))}`);
  } catch (err) {
    stopChild(child);
    throw err;
  }
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch { /* already gone */ }
  setTimeout(() => {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* already gone */ }
  }, 1000).unref();
}

/** Rewrites the configured baseUrl to point at the branch's local port. */
export function configForPort(config, port) {
  const url = new URL(config.baseUrl);
  url.protocol = 'http:';
  url.hostname = '127.0.0.1';
  url.port = String(port);
  url.hash = '';
  return { ...config, baseUrl: url.href.replace(/\/$/, '') };
}

/** High-level orchestration: refs -> worktrees -> two running apps -> two captures. */
export async function runBranchCapture({ config, outputDir, repoRoot, options = {}, log = () => {} }) {
  const opts = config.branchCompare || {};
  const stabilityCheck = options.stabilityCheck ?? opts.stabilityCheck;
  const keepTemp = options.keepTemp ?? opts.keepTemp;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-branch-'));
  let worktrees = null;
  const running = [];

  try {
    const refs = resolveBranchRefs({
      repoRoot,
      baseRef: options.baseRef || opts.baseRef,
      headRef: options.headRef || 'HEAD',
      baseStrategy: options.baseStrategy || opts.baseStrategy
    });
    log(`  Base: ${refs.baseRef} @ ${refs.baseSha.substring(0, 10)} (${options.baseStrategy || opts.baseStrategy})`);
    log(`  Head: ${refs.headRef} @ ${refs.headSha.substring(0, 10)}`);

    worktrees = createWorktrees({ repoRoot, ...refs, tempRoot });
    const nodeModulesSource = path.join(repoRoot, 'node_modules');

    const branches = [
      { label: 'base', sha: refs.baseSha, dir: worktrees.baseDir, port: opts.portBase, runId: 'base' },
      { label: 'head', sha: refs.headSha, dir: worktrees.headDir, port: opts.portHead, runId: 'head' }
    ];

    const captured = {};
    for (const branch of branches) {
      const server = await startApp({
        cwd: branch.dir,
        command: opts.startCommand,
        port: branch.port,
        waitOnPath: opts.waitOnPath,
        timeoutMs: opts.startTimeoutMs,
        installCommand: opts.installCommand,
        nodeModulesSource,
        label: branch.label
      });
      running.push(server);
      log(`  ${branch.label} app ready at ${redactUrl(server.url)}`);

      const branchConfig = configForPort(config, branch.port);
      const capture = (runId, suffix) => captureScreenshots(branchConfig, {
        runId,
        outputDir,
        collectDomTokens: true,
        collectDomProfile: true,
        settleMs: opts.settleMs,
        waitForSelector: opts.waitForSelector || undefined,
        scrollToBottom: opts.scrollToBottom,
        onProgress: (snap) => log(`    [${branch.label}${suffix}] ${snap.route} @ ${snap.viewport}`)
      });
      captured[branch.label] = await capture(branch.runId, '');
      if (stabilityCheck) {
        captured[`${branch.label}Repeat`] = await capture(`${branch.runId}2`, ' (repeat)');
      }
    }

    if (keepTemp) log(`  Kept temporary worktrees at ${tempRoot} (run \`git worktree prune\` to forget them).`);
    return {
      ...refs,
      baseSnapshots: captured.base,
      headSnapshots: captured.head,
      baseRepeatSnapshots: captured.baseRepeat || null,
      headRepeatSnapshots: captured.headRepeat || null,
      tempDir: keepTemp ? tempRoot : null
    };
  } finally {
    for (const server of running.reverse()) server.stop();
    if (!keepTemp) {
      if (worktrees) worktrees.cleanup();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

/** Repo root for the current checkout, or a clear error. */
export function findRepoRoot(cwd = process.cwd()) {
  return git(['rev-parse', '--show-toplevel'], cwd);
}
