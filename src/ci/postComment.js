import fs from 'node:fs';
import path from 'node:path';
import { BRANCH_MARKER, generateBranchReportMarkdown } from './branchReport.js';

/**
 * Posts (or updates) one sticky PR/MR comment with the branch-comparison report.
 * Works on GitHub Actions and GitLab CI through the same REST calls; the workflow
 * decides whether a token is available (fork PRs usually have a read-only token).
 */

export { BRANCH_MARKER };

export function buildCommentBody(result, reportPath, env = process.env) {
  let report = null;
  if (reportPath) {
    try { report = fs.readFileSync(path.resolve(process.cwd(), reportPath), 'utf8'); } catch { /* regenerate */ }
  }
  if (!report || !report.includes(BRANCH_MARKER)) {
    report = generateBranchReportMarkdown({ result });
  }
  const artifact = env.VRT_ARTIFACT_URL;
  if (artifact) report = `${report}\n📦 [Download the full comparison artifact](${artifact})\n`;
  return report;
}

function apiHeaders(token, scheme = 'Bearer') {
  return {
    'content-type': 'application/json',
    'user-agent': 'visual-ci-branch-compare',
    authorization: `${scheme} ${token}`,
    connection: 'close' // do not leave a keep-alive socket holding the CLI open
  };
}

async function readJson(response) {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Comment API returned ${response.status}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

/**
 * @param {object} options
 * @param {object} options.result - visual-branch-compare JSON
 * @param {'github'|'gitlab'} options.platform
 * @param {string} options.token
 * @param {object} options.env - platform variables (repository, PR/MR number, API URL)
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<{ action: 'created'|'updated'|'skipped', url?: string }>}
 */
export async function postComment({ result, platform, token, env = {}, fetchImpl = globalThis.fetch }) {
  if (!token) return { action: 'skipped', reason: 'no token' };
  if (platform === 'github') {
    const repo = env.GITHUB_REPOSITORY;
    const issue = env.GITHUB_PR_NUMBER || env.GITHUB_ISSUE_NUMBER;
    if (!repo || !issue) return { action: 'skipped', reason: 'no repository or PR number' };
    const api = env.GITHUB_API_URL || 'https://api.github.com';
    const base = `${api}/repos/${repo}/issues/${issue}/comments`;
    const body = buildCommentBody(result, result?.run?.report, env);
    const headers = apiHeaders(token, 'token'); // classic GitHub PATs use the "token" scheme
    const list = await readJson(await fetchImpl(`${base}?per_page=100`, { headers }));
    const existing = Array.isArray(list) && list.find((c) => typeof c.body === 'string' && c.body.includes(BRANCH_MARKER));
    const response = existing
      ? await fetchImpl(`${base}/${existing.id}`, { method: 'PATCH', headers, body: JSON.stringify({ body }) })
      : await fetchImpl(base, { method: 'POST', headers, body: JSON.stringify({ body }) });
    const created = await readJson(response);
    return { action: existing ? 'updated' : 'created', url: created.html_url };
  }
  if (platform === 'gitlab') {
    const project = env.CI_PROJECT_ID;
    const mr = env.CI_MERGE_REQUEST_IID;
    if (!project || !mr) return { action: 'skipped', reason: 'no project or MR iid' };
    const api = env.CI_API_V4_URL || 'https://gitlab.com/api/v4';
    const base = `${api}/projects/${encodeURIComponent(project)}/merge_requests/${mr}/notes`;
    const body = buildCommentBody(result, result?.run?.report, env);
    const list = await readJson(await fetchImpl(`${base}?per_page=100`, { headers: apiHeaders(token) }));
    const existing = Array.isArray(list) && list.find((n) => typeof n.body === 'string' && n.body.includes(BRANCH_MARKER));
    const response = existing
      ? await fetchImpl(`${base}/${existing.id}`, { method: 'PUT', headers: apiHeaders(token), body: JSON.stringify({ body }) })
      : await fetchImpl(base, { method: 'POST', headers: apiHeaders(token), body: JSON.stringify({ body }) });
    const created = await readJson(response);
    return { action: existing ? 'updated' : 'created', url: created.web_url };
  }
  throw new Error(`Unknown platform "${platform}"`);
}

/** CLI entry point used by both workflows. */
export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch) {
  const file = argv[0];
  if (!file) throw new Error('Usage: postComment.js <result.json>');
  const result = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'));
  const platform = env.VRT_PLATFORM || (env.GITHUB_ACTIONS ? 'github' : env.GITLAB_CI ? 'gitlab' : null);
  const token = platform === 'github' ? env.GITHUB_TOKEN : env.GL_TOKEN;
  const outcome = await postComment({ result, platform, token, env, fetchImpl });
  fs.writeSync(1, `visual-branch-compare comment: ${outcome.action}${outcome.url ? ` ${outcome.url}` : ''}\n`);
  return outcome;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  // fetch() can leave an undici keep-alive socket in the pool; exit explicitly so a
  // CI step never hangs after the comment has been posted. Output above is sync.
  main().then(() => process.exit(0)).catch((err) => {
    fs.writeSync(2, `[ERROR] Could not post the comment: ${String(err?.message ?? err)}\n`);
    process.exit(1);
  });
}
