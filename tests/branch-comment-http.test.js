import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { postComment, BRANCH_MARKER } from '../src/ci/postComment.js';
import { buildBranchCompareResult } from '../src/cli/branchCompare.js';

/** A tiny fake GitHub/GitLab API: GET lists notes, writes upsert the sticky note. */
async function fakeApi() {
  const notes = [];
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      requests.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      res.setHeader('connection', 'close');
      if (req.method === 'GET') {
        res.end(JSON.stringify(notes));
      } else {
        const note = { id: notes.length + 1, body: body.body, html_url: 'http://local/note', web_url: 'http://local/note' };
        if (req.method === 'PATCH' || req.method === 'PUT') {
          const index = Number(req.url.split('/').pop()) - 1;
          notes[index] = { ...note, id: index + 1 };
        } else {
          notes.push(note);
        }
        res.end(JSON.stringify(note));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    notes,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

const result = buildBranchCompareResult({
  runId: 'sim-1', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
  baseRef: 'main', headRef: 'feature', exitCode: 1,
  results: [{ route: '/', viewport: 'desktop', status: 'DIFF', mismatchPercentage: 4.2, suspects: [] }]
});

describe('PR/MR comment over real HTTP', () => {
  it('creates then updates one sticky GitHub comment', async () => {
    const api = await fakeApi();
    try {
      const env = { GITHUB_REPOSITORY: 'org/repo', GITHUB_PR_NUMBER: '12', GITHUB_API_URL: api.base };
      const first = await postComment({ result, platform: 'github', token: 'ghp_localtest', env });
      const second = await postComment({ result, platform: 'github', token: 'ghp_localtest', env });
      expect([first.action, second.action]).toEqual(['created', 'updated']);
      expect(api.notes).toHaveLength(1);
      expect(api.notes[0].body).toContain(BRANCH_MARKER);
      expect(api.notes[0].body).toContain('4.2%');
      expect(api.requests[0].authorization).toBe('token ghp_localtest');
      expect(api.requests.every((r) => !JSON.stringify(r).includes('ghp_localtest') || r.authorization === 'token ghp_localtest')).toBe(true);
      expect(api.requests.some((r) => r.method === 'PATCH')).toBe(true);
    } finally {
      await api.close();
    }
  });

  it('creates then updates one sticky GitLab MR note', async () => {
    const api = await fakeApi();
    try {
      const env = { CI_PROJECT_ID: '42', CI_MERGE_REQUEST_IID: '7', CI_API_V4_URL: api.base };
      const first = await postComment({ result, platform: 'gitlab', token: 'glpat-localtest', env });
      const second = await postComment({ result, platform: 'gitlab', token: 'glpat-localtest', env });
      expect([first.action, second.action]).toEqual(['created', 'updated']);
      expect(api.notes).toHaveLength(1);
      expect(api.notes[0].body).toContain(BRANCH_MARKER);
      expect(api.requests.some((r) => r.method === 'PUT')).toBe(true);
    } finally {
      await api.close();
    }
  });
});
