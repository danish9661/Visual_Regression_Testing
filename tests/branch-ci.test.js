import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import YAML from 'yaml';

import { postComment, buildCommentBody, BRANCH_MARKER } from '../src/ci/postComment.js';
import { buildBranchCompareResult } from '../src/cli/branchCompare.js';

const result = buildBranchCompareResult({
  runId: 'gh-1-1', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
  baseRef: 'main', headRef: 'feature', exitCode: 1,
  results: [{ route: '/', viewport: 'desktop', status: 'DIFF', mismatchPercentage: 2.5, suspects: [] }]
});

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('sticky PR/MR comment', () => {
  it('builds a report body with the marker', () => {
    expect(buildCommentBody(result, null)).toContain(BRANCH_MARKER);
  });

  it('adds the artifact link when the workflow supplies one', () => {
    const body = buildCommentBody(result, null, { VRT_ARTIFACT_URL: 'https://github.com/o/r/actions/runs/1/artifacts/2' });
    expect(body).toContain('[Download the full comparison artifact](https://github.com/o/r/actions/runs/1/artifacts/2)');
  });

  it('creates a GitHub comment and never includes the token in the request', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return options?.method ? jsonResponse({ html_url: 'https://github.com/o/r/issues/7#issuecomment-1' }) : jsonResponse([]);
    };
    const out = await postComment({
      result, platform: 'github', token: 'ghp_SUPERSECRET',
      env: { GITHUB_REPOSITORY: 'o/r', GITHUB_PR_NUMBER: '7', GITHUB_API_URL: 'https://api.github.com' },
      fetchImpl
    });
    expect(out.action).toBe('created');
    expect(calls[1].options.method).toBe('POST');
    expect(calls[1].options.body).toContain(BRANCH_MARKER);
    expect(calls[1].options.body).not.toContain('ghp_SUPERSECRET');
    expect(calls[1].options.headers.authorization).toBe('token ghp_SUPERSECRET');
  });

  it('updates an existing sticky GitHub comment instead of posting another', async () => {
    const methods = [];
    const fetchImpl = async (_url, options) => {
      if (!options?.method) return jsonResponse([{ id: 42, body: `old ${BRANCH_MARKER}` }]);
      methods.push(options.method);
      return jsonResponse({ html_url: 'url' });
    };
    const out = await postComment({
      result, platform: 'github', token: 'secret',
      env: { GITHUB_REPOSITORY: 'o/r', GITHUB_PR_NUMBER: '7' }, fetchImpl
    });
    expect(out.action).toBe('updated');
    expect(methods).toEqual(['PATCH']);
  });

  it('creates or updates a GitLab MR note', async () => {
    const methods = [];
    const fetchImpl = async (_url, options) => {
      if (!options?.method) return jsonResponse([]);
      methods.push(options.method);
      return jsonResponse({ web_url: 'https://gitlab.example/mr#note_1' });
    };
    const out = await postComment({
      result, platform: 'gitlab', token: 'glpat-secret',
      env: { CI_PROJECT_ID: '123', CI_MERGE_REQUEST_IID: '9' }, fetchImpl
    });
    expect(out.action).toBe('created');
    expect(methods).toEqual(['POST']);
  });

  it('skips cleanly when there is no token or no PR context', async () => {
    expect(await postComment({ result, platform: 'github', token: '', env: {} })).toEqual({ action: 'skipped', reason: 'no token' });
    expect(await postComment({ result, platform: 'github', token: 'x', env: {} })).toEqual({ action: 'skipped', reason: 'no repository or PR number' });
  });
});

describe('CI workflow wiring', () => {
  const ghText = fs.readFileSync('.github/workflows/visual-branch-compare.yml', 'utf8');
  const glText = fs.readFileSync('.gitlab-ci.yml', 'utf8');

  it('GitHub workflow triggers on PRs to main and has comment permissions', () => {
    const workflow = YAML.parse(ghText);
    const triggers = workflow.on || workflow[true];
    expect(triggers.pull_request.branches).toContain('main');
    expect(triggers.pull_request.types).toContain('synchronize');
    expect(workflow.permissions['pull-requests']).toBe('write');
    expect(workflow.permissions.contents).toBe('read');
    // `inputs.*` is only valid on workflow_dispatch; this workflow also runs on push.
    expect(ghText).not.toMatch(/\$\{\{\s*inputs\./);
  });

  it('GitHub workflow builds the image, runs the comparison and posts a comment', () => {
    const steps = YAML.parse(ghText).jobs.compare.steps;
    const commands = steps.map((s) => `${s.name || ''} ${s.run || ''} ${s.uses || ''}`).join('\n');
    expect(commands).toContain('docker build');
    expect(commands).toContain('compare-branches');
    expect(commands).toContain('postComment.js');
    expect(commands).toContain('upload-artifact');
    const comment = steps.find((s) => s.run?.includes('postComment.js'));
    expect(comment.if).toContain('head.repo.full_name == github.repository');
    expect(comment.env.VRT_ARTIFACT_URL).toContain('artifact-url');
    expect(steps.find((s) => s.uses?.includes('upload-artifact')).id).toBe('upload');
  });

  it('GitLab job runs only for MRs with the pinned image and a JUnit artifact', () => {
    const config = YAML.parse(glText);
    const job = config['visual-branch-compare'];
    expect(job.image).toBe('mcr.microsoft.com/playwright:v1.64.1-noble');
    expect(job.rules[0].if).toContain('merge_request_event');
    expect(job.script.join('\n')).toContain('compare-branches');
    expect(job.script.join('\n')).toContain('postComment.js');
    expect(job.artifacts.reports.junit).toContain('junit.xml');
    expect(job.artifacts.paths.join('\n')).toContain('result.json');
  });
});
