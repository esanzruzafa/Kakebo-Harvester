import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("Electron packaging download proxy", () => {
  it("routes downloads through the proxy initialized by the packaging downloader", async () => {
    const script = `
      const assert = require('node:assert/strict');
      const http = require('node:http');
      const { createRequire } = require('node:module');
      const getRequire = createRequire(require.resolve('app-builder-lib/package.json'));
      const downloader = getRequire('@electron/get');
      const target = http.createServer((_request, response) => response.end('direct'));
      const proxy = http.createServer((request, response) => {
        assert.match(request.url, /^http:\\/\\/127\\.0\\.0\\.1:/);
        response.end('proxied');
      });
      const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      (async () => {
        await listen(target);
        await listen(proxy);
        for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) delete process.env[name];
        process.env.GLOBAL_AGENT_HTTP_PROXY = 'http://127.0.0.1:' + proxy.address().port;
        process.env.GLOBAL_AGENT_HTTPS_PROXY = process.env.GLOBAL_AGENT_HTTP_PROXY;
        process.env.GLOBAL_AGENT_NO_PROXY = '';
        downloader.initializeProxy();
        try {
          const body = await new Promise((resolve, reject) => {
            http.get('http://127.0.0.1:' + target.address().port + '/artifact', response => {
              let body = '';
              response.on('data', chunk => body += chunk);
              response.on('end', () => resolve(body));
            }).on('error', reject);
          });
          assert.equal(body, 'proxied');
          console.log('Electron packaging proxy verified.');
        } finally {
          target.close();
          proxy.close();
        }
      })().catch(error => { console.error(error.message); process.exitCode = 1; });
    `;
    const { stdout } = await execFileAsync(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      timeout: 10_000
    });
    expect(stdout).toContain("Electron packaging proxy verified.");
  });
});
