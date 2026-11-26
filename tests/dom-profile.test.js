import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { captureScreenshots } from '../src/cli/capture.js';
import { diffDomProfiles, domProfileTokens } from '../src/cli/domProfile.js';

let server;
let dir;

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function serve(html) {
  return new Promise(async (resolve) => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    resolve(`http://127.0.0.1:${server.address().port}`);
  });
}

const page = (state) => `<!doctype html><html><head><title>Checkout</title><style>
  .hero { color: ${state === 'ok' ? 'rgb(10, 10, 10)' : 'rgb(220, 20, 20)'}; }
</style></head><body>
  <main id="app" class="hero ${state === 'ok' ? '' : 'error'}" data-state="${state}">${state === 'ok' ? 'Ready' : 'Payment failed'}</main>
</body></html>`;

describe('Playwright DOM/style profile diff', () => {
  const capture = async (baseUrl, runId) => captureScreenshots({
    baseUrl, routes: ['/'], viewports: [{ name: 'desktop', width: 320, height: 240 }], maskSelectors: [], threshold: 0.01
  }, { runId, outputDir: dir, collectDomTokens: true, collectDomProfile: true });

  it('reports the attributes that changed between two branches', async () => {
    const baseUrl = await serve(page('ok'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-profile-'));
    const base = (await capture(baseUrl, 'base'))[0];
    await new Promise((resolve) => server.close(resolve));
    const headUrl = await serve(page('failed'));
    const head = (await capture(headUrl, 'head'))[0];

    expect(base.domProfile).toBeTruthy();
    expect(head.domProfile).toBeTruthy();
    const changes = diffDomProfiles(base.domProfile, head.domProfile);
    const byAttribute = (name) => changes.find((c) => c.attribute === name);

    expect(byAttribute('class')?.before).toBe('hero');
    expect(byAttribute('class')?.after).toBe('hero error');
    expect(byAttribute('data.data-state')?.after).toBe('failed');
    expect(byAttribute('text')?.after).toBe('Payment failed');
    expect(byAttribute('style.color')?.after).toContain('220, 20, 20');

    const tokens = domProfileTokens(head.domProfile);
    expect(tokens).toContain('.error');
    expect(tokens).toContain('state:failed');
    expect(tokens).toContain('text:Payment failed');
  }, 120000);

  it('returns no changes when a profile is missing', () => {
    expect(diffDomProfiles(null, { elements: [] })).toEqual([]);
  });
});
