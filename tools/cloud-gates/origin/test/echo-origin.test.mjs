/**
 * Echo origin tests: what the gates read from /echo and /ws is what a client actually sent.
 *
 * Starts createEchoServer() on an ephemeral loopback port and drives it with fetch, the ws
 * client and the ws-probe CLI, so the HTTP version, header echo, cookie hashing and the
 * WebSocket upgrade echo are pinned before any gate relies on them.
 *
 * - Binds 127.0.0.1 port 0 only; no network beyond loopback.
 * - Pins the G6 viewport copy against yaran's real index.html so the two cannot drift.
 *
 * <module-headers:begin>
 * Uses:
 * test/echo-origin.test.mjs
 * └── echo-origin.mjs
 * External: ws, node:test, node:assert/strict, node:crypto, node:child_process, node:fs, node:url
 *
 * Used by:
 * test/echo-origin.test.mjs
 * └── entry point (node --test)
 * <module-headers:end>
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createEchoServer, YARAN_VIEWPORT, BASE_VIEWPORT } from '../echo-origin.mjs';

let server;
let base;

before(async () => {
  server = createEchoServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const hex = (v) => `sha256:${createHash('sha256').update(v).digest('hex')}`;

test('/echo reports HTTP/1.1, the request line, headers and hashed credentials', async () => {
  const res = await fetch(`http://${base}/echo?x=1`, {
    headers: { 'x-gate': 'hello', 'cf-access-jwt-assertion': 'jwt-value', cookie: 'a=1; CF_Authorization=cookie-value' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.httpVersion, '1.1');
  assert.equal(body.requestLine, 'GET /echo?x=1 HTTP/1.1');
  assert.equal(body.path, '/echo?x=1');
  assert.equal(body.headers['x-gate'], 'hello');
  assert.deepEqual(body.cookieNames, ['a', 'CF_Authorization']);
  assert.equal(body.sha256.CF_Authorization, hex('cookie-value'));
  assert.equal(body.sha256['cf-access-jwt-assertion'], hex('jwt-value'));
  assert.match(body.sha256.CF_Authorization, /^sha256:[0-9a-f]{64}$/);
});

test('/echo hashes a known input to the known digest and reports absence as null', async () => {
  const res = await fetch(`http://${base}/echo`, { headers: { cookie: 'CF_Authorization=abc' } });
  const body = await res.json();
  assert.equal(body.sha256.CF_Authorization, 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(body.sha256['cf-access-jwt-assertion'], null);
});

test('/echo renders HTML with the sha256 string when asked for text/html', async () => {
  const res = await fetch(`http://${base}/echo`, { headers: { accept: 'text/html', cookie: 'CF_Authorization=abc' } });
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.ok(html.includes(hex('abc')));
  assert.ok(html.includes('<details>'));
});

test('unknown paths are 404 JSON', async () => {
  const res = await fetch(`http://${base}/nope`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'not_found');
});

test('/g6 carries yaran viewport, and the variant drops interactive-widget', async () => {
  const indexHtml = readFileSync(fileURLToPath(new URL('../../../../crates/yaran-web/web/index.html', import.meta.url)), 'utf8');
  assert.ok(indexHtml.includes(`name="viewport" content="${YARAN_VIEWPORT}"`), 'YARAN_VIEWPORT drifted from index.html');
  const plain = await (await fetch(`http://${base}/g6`)).text();
  assert.ok(plain.includes(`content="${YARAN_VIEWPORT}"`));
  const variant = await (await fetch(`http://${base}/g6?variant=no-interactive-widget`)).text();
  assert.ok(variant.includes(`content="${BASE_VIEWPORT}"`) && !variant.includes('interactive-widget'));
  const upload = await fetch(`http://${base}/g6/upload`, { method: 'POST', body: 'twelve bytes', headers: { 'content-type': 'text/plain' } });
  assert.deepEqual(await upload.json(), { bytes: 12, contentType: 'text/plain' });
});

test('/ws sends the upgrade message first, then echoes', async () => {
  const ws = new WebSocket(`ws://${base}/ws`, { headers: { 'x-gate': 'ws' } });
  const messages = [];
  await new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (data) => {
      messages.push(data.toString());
      if (messages.length === 1) ws.send('ping-123');
      else ws.close();
    });
    ws.on('close', resolve);
  });
  const upgrade = JSON.parse(messages[0]);
  assert.equal(upgrade.kind, 'upgrade');
  assert.equal(upgrade.httpVersion, '1.1');
  assert.equal(upgrade.requestLine, 'GET /ws HTTP/1.1');
  assert.equal(upgrade.headers['x-gate'], 'ws');
  assert.equal(upgrade.headers.upgrade, 'websocket');
  assert.equal(messages[1], 'ping-123');
});

test('a WebSocket upgrade on any other path is refused with 404', async () => {
  const status = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://${base}/echo`);
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('error', () => resolve('error'));
  });
  assert.equal(status, 404);
});

test('ws-probe exits 0 after an echo round trip', async () => {
  const probe = fileURLToPath(new URL('../ws-probe.mjs', import.meta.url));
  const { stdout } = await new Promise((resolve, reject) => {
    execFile(process.execPath, [probe, `ws://${base}/ws`], (err, out) => (err ? reject(err) : resolve({ stdout: out })));
  });
  const result = JSON.parse(stdout.trim());
  assert.deepEqual(result, { status: 101, opened: true, firstMessageKind: 'upgrade', echoed: true });
});
