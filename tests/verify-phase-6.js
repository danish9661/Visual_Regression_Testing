#!/usr/bin/env node
/**
 * Phase 6 deliverable verification: base-vs-head (PR/MR) visual comparison.
 * Static checks only, so it can run without a browser or a git checkout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripJsonComments } from '../src/cli/config.js';

const root = process.cwd();
const checks = [];
const check = (name, fn) => {
  try {
    const ok = fn();
    checks.push({ name, ok, detail: ok ? '' : 'condition was false' });
  } catch (err) {
    checks.push({ name, ok: false, detail: err.message });
  }
};
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

for (const file of [
  'src/cli/branchCapture.js',
  'src/cli/branchCompare.js',
  'src/ci/codeCorrelation.js',
  'src/ci/branchReport.js',
  'src/ci/postComment.js',
  '.github/workflows/visual-branch-compare.yml',
  '.gitlab-ci.yml',
  'tests/branch-compare.test.js',
  'tests/branch-ci.test.js',
  'tests/branch-comment-http.test.js',
  'tests/simulate-pr.js'
]) {
  check(`${file} exists`, () => exists(file));
}

check('visual.config.json has a branchCompare block', () => {
  const config = JSON.parse(stripJsonComments(read('visual.config.json')));
  return Boolean(config.branchCompare && config.branchCompare.startCommand && config.branchCompare.baseRef);
});

check('CLI advertises compare-branches', () => {
  const out = spawnSync(process.execPath, ['src/cli/index.js', '--help'], { cwd: root, encoding: 'utf8' });
  return out.status === 0 && out.stdout.includes('compare-branches');
});

check('GitHub workflow runs the comparison, uploads and comments', () => {
  const text = read('.github/workflows/visual-branch-compare.yml');
  return text.includes('compare-branches') && text.includes('postComment.js') &&
    text.includes('upload-artifact') && text.includes('pull-requests: write');
});

check('GitLab job runs the comparison for merge requests', () => {
  const text = read('.gitlab-ci.yml');
  return text.includes('merge_request_event') && text.includes('compare-branches') &&
    text.includes('postComment.js') && text.includes('junit:');
});

check('README documents the feature', () => {
  const text = read('README.md');
  return text.includes('visual-branch-compare') && text.includes('branchCompare') && text.includes('GL_TOKEN');
});

const failed = checks.filter((c) => !c.ok);
console.log('======================================================');
console.log('  [PHASE 6 VERIFICATION] Branch comparison on PR/MR');
console.log('======================================================');
for (const c of checks) {
  console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
}
console.log('======================================================');
if (failed.length) {
  console.log(`[FAIL] ${failed.length} of ${checks.length} checks failed`);
  process.exit(1);
}
console.log(`[PASS] ALL ${checks.length} PHASE 6 DELIVERABLES VERIFIED SUCCESSFULLY`);
