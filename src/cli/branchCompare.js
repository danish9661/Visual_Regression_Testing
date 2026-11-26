import fs from 'node:fs';
import path from 'node:path';
import { compareImages, DEFAULT_PIXELMATCH_THRESHOLD } from './compare.js';
import { getSnapshotFilename } from './naming.js';
import { getToolVersion } from './manifest.js';
import { toDisplayPath } from './display.js';
import { writeResult, classifyError, sanitizeMessage, toError } from './result.js';

/**
 * Diffs the two renders of a branch comparison. The base screenshot is the
 * reference; no shared baseline is read or written.
 */
export const BRANCH_COMPARE_SCHEMA = 'visual-branch-compare';
export const BRANCH_COMPARE_VERSION = 1;

const round6 = (value) => Math.round((value || 0) * 1e6) / 1e6;

/**
 * @param {object} options
 * @param {object[]} options.baseSnapshots - Captures from the base branch
 * @param {object[]} options.headSnapshots - Captures from the head branch
 * @param {string} options.diffDir - Where diff PNGs are written
 * @param {number} [options.allowedThresholdRatio=0.01] - Mismatch ratio considered a match
 * @param {number} [options.pixelmatchThreshold] - pixelmatch colour sensitivity
 * @returns {object[]} Comparison records (one per head snapshot)
 */
export function compareBranchSnapshots({
  baseSnapshots,
  headSnapshots,
  diffDir,
  allowedThresholdRatio = 0.01,
  pixelmatchThreshold = DEFAULT_PIXELMATCH_THRESHOLD,
  routeThresholds = {},
  repeatBaseSnapshots = null,
  repeatHeadSnapshots = null
}) {
  fs.mkdirSync(diffDir, { recursive: true });
  const key = (snap) => `${snap.route}\u0000${snap.viewport}`;
  const baseByKey = new Map(baseSnapshots.map((snap) => [key(snap), snap]));
  const repeatBaseByKey = new Map((repeatBaseSnapshots || []).map((snap) => [key(snap), snap]));
  const repeatHeadByKey = new Map((repeatHeadSnapshots || []).map((snap) => [key(snap), snap]));

  return headSnapshots.map((head) => {
    // A route can override the global percentage (e.g. a chart that legitimately moves).
    const thresholdPercent = routeThresholds[head.route] ?? allowedThresholdRatio * 100;
    const base = baseByKey.get(key(head));
    const record = {
      route: head.route,
      viewport: head.viewport,
      tokens: head.tokens || [],
      basePath: base?.filepath || null,
      headPath: head.filepath,
      diffPath: null,
      mismatchedPixels: 0,
      totalPixels: 0,
      mismatchPercentage: 0,
      width: head.width,
      height: head.height,
      status: 'MATCH',
      dimensions: null,
      thresholdPercent,
      noiseFiltered: false,
      repeatMismatchPercentage: null
    };

    // A route added in the PR has no base render: report it explicitly, do not
    // silently treat it as unchanged or create a baseline.
    if (!base || !fs.existsSync(base.filepath)) {
      record.status = 'MISSING_BASE';
      return record;
    }

    const comparison = compareImages(fs.readFileSync(base.filepath), fs.readFileSync(head.filepath), {
      threshold: pixelmatchThreshold
    });
    const filename = getSnapshotFilename(head.route, head.viewport);
    const diffPath = path.join(diffDir, `${path.parse(filename).name}-diff.png`);
    fs.writeFileSync(diffPath, comparison.diffBuffer);

    const recordWithDiff = {
      ...record,
      diffPath,
      mismatchedPixels: comparison.mismatchedPixels,
      totalPixels: comparison.totalPixels,
      mismatchPercentage: comparison.mismatchPercentage,
      status: comparison.mismatchPercentage <= thresholdPercent ? 'MATCH' : 'DIFF',
      dimensions: comparison.dimensions
    };

    // Stability check: both independent captures must exceed the threshold before a
    // snapshot is called a change. This filters out clocks, beacons and flaky effects.
    if (repeatBaseByKey.size && repeatHeadByKey.size) {
      const repeatBase = repeatBaseByKey.get(key(head));
      const repeatHead = repeatHeadByKey.get(key(head));
      if (repeatBase && repeatHead && fs.existsSync(repeatBase.filepath) && fs.existsSync(repeatHead.filepath)) {
        const repeat = compareImages(fs.readFileSync(repeatBase.filepath), fs.readFileSync(repeatHead.filepath), {
          threshold: pixelmatchThreshold
        });
        recordWithDiff.repeatMismatchPercentage = repeat.mismatchPercentage;
        if (recordWithDiff.status === 'DIFF' && repeat.mismatchPercentage <= thresholdPercent) {
          recordWithDiff.status = 'MATCH';
          recordWithDiff.noiseFiltered = true;
        }
      }
    }
    return recordWithDiff;
  });
}

/**
 * Builds the machine-readable `visual-branch-compare` result.
 *
 * @param {object} options
 * @returns {object}
 */
export function buildBranchCompareResult({
  runId,
  baseSha,
  headSha,
  baseRef,
  headRef,
  baseStrategy = 'merge-base',
  thresholdPercent = 1,
  onRegression = 'fail',
  exitCode = 0,
  results = [],
  runDir = null,
  reportPath = null,
  createdAt = new Date(),
  durationMs = null,
  error = null,
  skipped = false
}) {
  const snapshots = results.map((r) => ({
    route: r.route,
    viewport: r.viewport,
    status: r.status,
    mismatch_percentage: round6(r.mismatchPercentage),
    threshold_percentage: round6(r.thresholdPercent ?? thresholdPercent),
    noise_filtered: Boolean(r.noiseFiltered),
    repeat_mismatch_percentage: r.repeatMismatchPercentage === null || r.repeatMismatchPercentage === undefined
      ? null : round6(r.repeatMismatchPercentage),
    base: toDisplayPath(r.basePath),
    head: toDisplayPath(r.headPath),
    diff: toDisplayPath(r.diffPath),
    suspects: r.suspects || []
  }));
  const changed = snapshots.filter((s) => s.status === 'DIFF' || s.status === 'MISSING_BASE').length;
  const err = error ? toError(error) : null;

  return {
    schema: BRANCH_COMPARE_SCHEMA,
    version: BRANCH_COMPARE_VERSION,
    tool: { name: 'visual-ci', version: getToolVersion() },
    command: 'compare-branches',
    base: baseSha || baseRef ? { ref: baseRef ?? null, sha: baseSha ?? null, strategy: baseStrategy } : null,
    head: headSha || headRef ? { ref: headRef ?? null, sha: headSha ?? null } : null,
    status: err ? 'error' : skipped ? 'skipped' : changed > 0 ? 'failed' : 'passed',
    exit_code: err ? 2 : exitCode,
    error: err ? { code: classifyError(err), message: sanitizeMessage(err.message) } : null,
    on_regression: onRegression,
    skipped: Boolean(skipped),
    threshold_percentage: round6(thresholdPercent),
    run: {
      id: runId,
      created_at: createdAt.toISOString(),
      duration_ms: durationMs,
      run_dir: toDisplayPath(runDir),
      report: toDisplayPath(reportPath)
    },
    counts: {
      total: snapshots.length,
      matched: snapshots.filter((s) => s.status === 'MATCH').length,
      changed
    },
    snapshots
  };
}

/** Writes the result atomically (or to stdout with "-"). */
export function writeBranchCompareResult(result, target) {
  return writeResult(result, target);
}
