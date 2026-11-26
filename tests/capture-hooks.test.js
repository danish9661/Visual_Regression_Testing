import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { captureScreenshots } from '../src/cli/capture.js';

let server;
let dir;

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function serve(html) {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function config(baseUrl) {
  return {
    baseUrl,
    routes: ['/'],
    viewports: [{ name: 'desktop', width: 320, height: 240 }],
    maskSelectors: [],
    threshold: 0.01
  };
}

describe('capture hooks for complex SPAs', () => {
  it('waits for a selector that appears after load', async () => {
    const baseUrl = await serve(`<!doctype html><html><body>
      <script>setTimeout(() => { const d = document.createElement('div'); d.className = 'late'; d.textContent = 'ready'; document.body.appendChild(d); }, 300);</script>
    </body></html>`);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-hooks-'));

    const results = await captureScreenshots(config(baseUrl), {
      runId: 'hooks_selector',
      outputDir: dir,
      waitForSelector: '.late',
      settleMs: 20,
      collectDomTokens: true
    });

    expect(results).toHaveLength(1);
    expect(results[0].tokens).toContain('.late');
    expect(fs.existsSync(results[0].filepath)).toBe(true);
  }, 60000);

  it('scrolls through the page to trigger lazy content', async () => {
    const baseUrl = await serve(`<!doctype html><html><head><style>
      .spacer { height: 1800px; }
    </style></head><body>
      <div class="spacer"></div><div id="bottom">bottom</div>
      <script>
        const observer = new IntersectionObserver((entries) => {
          if (entries[0].isIntersecting) document.body.classList.add('seen');
        });
        observer.observe(document.getElementById('bottom'));
      </script>
    </body></html>`);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-scroll-'));

    const results = await captureScreenshots(config(baseUrl), {
      runId: 'hooks_scroll',
      outputDir: dir,
      scrollToBottom: true,
      waitForSelector: 'body.seen',
      settleMs: 20,
      collectDomTokens: true
    });

    expect(results[0].tokens).toContain('.seen');
  }, 60000);
});
