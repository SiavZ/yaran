/**
 * Echo origin: HTTP and WebSocket echo server behind cloudflared for gates G1, G2, G3, G6 and G12.
 *
 * The gates need to see exactly what reached the origin after Cloudflare Access and
 * cloudflared handled a request: the request line, the HTTP version, every header and
 * cookie, and the upgrade request of a WebSocket. This server echoes all of that back to
 * the caller (the operator's own screen or a gate script that records through
 * lib/redact.sh) and serves the two in-WebView test pages (/g6 and /expiry).
 *
 * - Server stdout carries header NAMES and `sha256:<hex>` digests only, never a raw value,
 *   so the Access JWT and the CF_Authorization cookie never reach a terminal log.
 * - Response bodies do carry raw values: they go to the requester, who already holds them.
 * - Uploads to /g6/upload are counted and discarded; nothing is written to disk.
 * - Listens only when run as the main module, so tests can drive createEchoServer().
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:crypto, node:http, node:url, ws
 *
 * Used by:
 * echo-origin.mjs
 * └── test/echo-origin.test.mjs
 * <module-headers:end>
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

/** Copied from crates/yaran-web/web/index.html; test/echo-origin.test.mjs fails on drift. */
export const YARAN_VIEWPORT =
  'width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content';
export const BASE_VIEWPORT = YARAN_VIEWPORT.replace(/,\s*interactive-widget=[^,]*/, '');

const sha = (v) => (v == null ? null : `sha256:${createHash('sha256').update(v).digest('hex')}`);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Parses a Cookie header into [name, value] pairs, keeping duplicates in order. */
export function parseCookies(header) {
  if (!header) return [];
  return header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      return eq < 0 ? [part, ''] : [part.slice(0, eq), part.slice(eq + 1)];
    });
}

/** Everything the gates compare, built from one request. Raw values stay in `headers`. */
export function describeRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const cfAuth = cookies.find(([name]) => name === 'CF_Authorization');
  return {
    requestLine: `${req.method} ${req.url} HTTP/${req.httpVersion}`,
    method: req.method,
    path: req.url,
    httpVersion: req.httpVersion,
    headers: { ...req.headers },
    cookieNames: cookies.map(([name]) => name),
    sha256: {
      'cf-access-jwt-assertion': sha(req.headers['cf-access-jwt-assertion']),
      CF_Authorization: sha(cfAuth ? cfAuth[1] : null),
    },
  };
}

function logLine(d) {
  const line = {
    t: new Date().toISOString(),
    method: d.method,
    path: d.path,
    httpVersion: d.httpVersion,
    headerNames: Object.keys(d.headers),
    sha256: d.sha256,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

const json = (res, status, obj) => send(res, status, 'application/json', `${JSON.stringify(obj, null, 2)}\n`);

function page(title, viewport, body, script) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="${esc(viewport)}"><title>${esc(title)}</title>
<style>body{font:14px/1.4 system-ui,sans-serif;margin:12px;word-break:break-all}
code,pre{font:12px ui-monospace,monospace}.hash{font-size:16px;font-weight:bold}
#log div{border-bottom:1px solid #ccc;padding:2px 0}</style></head><body>
<h1>${esc(title)}</h1>${body}<script>${script || ''}</script></body></html>`;
}

function echoHtml(d) {
  const jwt = d.headers['cf-access-jwt-assertion'];
  const cookie = parseCookies(d.headers.cookie).find(([n]) => n === 'CF_Authorization');
  const raw = (label, v) =>
    v == null ? `<p>${label}: absent</p>` : `<details><summary>${label} (raw, your screen only)</summary><pre>${esc(v)}</pre></details>`;
  const body = `<p><code>${esc(d.requestLine)}</code></p>
<p>cf-access-jwt-assertion:<br><span class="hash">${esc(d.sha256['cf-access-jwt-assertion'] ?? 'absent')}</span></p>
${raw('Cf-Access-Jwt-Assertion header', jwt)}
<p>CF_Authorization cookie:<br><span class="hash">${esc(d.sha256.CF_Authorization ?? 'absent')}</span></p>
${raw('CF_Authorization cookie value', cookie ? cookie[1] : null)}
<p>Cookie names: <code>${esc(d.cookieNames.join(', ') || '(none)')}</code></p>
<h2>Headers</h2><pre>${esc(JSON.stringify(d.headers, null, 2))}</pre>`;
  return page('yaran gate echo', BASE_VIEWPORT, body);
}

const G6_SCRIPT = `
const logEl = document.getElementById('log');
const log = (m) => { const el = document.createElement('div');
  el.textContent = new Date().toISOString().slice(11, 23) + ' ' + m; logEl.prepend(el); };
const probe = document.getElementById('probe');
const insets = () => { const s = getComputedStyle(probe);
  return 'inset t=' + s.paddingTop + ' r=' + s.paddingRight + ' b=' + s.paddingBottom + ' l=' + s.paddingLeft; };
const vp = (tag) => log(tag + ' vv.h=' + (window.visualViewport ? visualViewport.height : 'n/a') +
  ' innerH=' + innerHeight + ' ' + insets());
document.getElementById('bridge').textContent =
  'typeof Capacitor=' + typeof window.Capacitor + ' typeof androidBridge=' + typeof window.androidBridge;
document.getElementById('jscookie').textContent = 'document.cookie length=' + document.cookie.length;
addEventListener('resize', () => vp('resize'));
if (window.visualViewport) visualViewport.addEventListener('resize', () => vp('vv-resize'));
document.addEventListener('focusin', (e) => log('focusin ' + (e.target.id || e.target.tagName)));
document.addEventListener('focusout', (e) => log('focusout ' + (e.target.id || e.target.tagName)));
for (const id of ['multi', 'camera']) {
  document.getElementById(id).addEventListener('change', async (e) => {
    const files = [...e.target.files]; if (!files.length) return log(id + ': no files');
    const fd = new FormData(); files.forEach((f) => fd.append('file', f, f.name));
    log(id + ': uploading ' + files.length + ' file(s)');
    try { const r = await fetch('/g6/upload', { method: 'POST', body: fd, credentials: 'include' });
      log(id + ': ' + r.status + ' ' + await r.text()); } catch (err) { log(id + ': upload failed ' + err); }
  });
}
vp('load');`;

// yaran already ships interactive-widget=resizes-content, so the contrast page is the one without it.
function g6Page(d, variant) {
  const viewport = variant === 'no-interactive-widget' ? BASE_VIEWPORT : YARAN_VIEWPORT;
  const body = `<p id="bridge"></p>
<p>Cookie names seen by the server: <code>${esc(d.cookieNames.join(', ') || '(none)')}</code></p>
<p id="jscookie"></p><p>Viewport meta: <code>${esc(viewport)}</code></p>
<p><label>Multiple files <input id="multi" type="file" multiple></label></p>
<p><label>Camera <input id="camera" type="file" accept="image/*" capture></label></p>
<div id="probe" style="position:absolute;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)"></div>
<div id="log" style="padding-bottom:120px"></div>
<textarea id="bottom" rows="3" placeholder="Bottom-anchored textarea: tap to raise the keyboard"
 style="position:fixed;left:0;right:0;bottom:0;width:100%;box-sizing:border-box"></textarea>`;
  return page('yaran gate G6', viewport, body, G6_SCRIPT);
}

const EXPIRY_SCRIPT = `
const logEl = document.getElementById('log');
const log = (o) => { const el = document.createElement('div');
  el.textContent = JSON.stringify({ t: new Date().toISOString(), ...o }); logEl.prepend(el); };
async function poll() {
  try { const r = await fetch('/echo', { redirect: 'manual', credentials: 'include' });
    log({ kind: 'fetch', type: r.type, status: r.status, ok: r.ok }); }
  catch (err) { log({ kind: 'fetch', error: String(err) }); }
}
function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => log({ kind: 'ws', event: 'open' });
  ws.onerror = () => log({ kind: 'ws', event: 'error' });
  ws.onclose = (e) => { log({ kind: 'ws', event: 'close', code: e.code, reason: e.reason, wasClean: e.wasClean });
    setTimeout(connect, 10000); };
}
poll(); setInterval(poll, 10000); connect();`;

function expiryPage() {
  return page('yaran gate expiry', BASE_VIEWPORT, '<p>Fetch /echo and hold /ws, every 10 s.</p><div id="log"></div>', EXPIRY_SCRIPT);
}

function countUpload(req, res) {
  let bytes = 0;
  req.on('data', (chunk) => {
    bytes += chunk.length;
  });
  req.on('end', () => json(res, 200, { bytes, contentType: req.headers['content-type'] ?? null }));
  req.on('error', () => res.destroy());
}

function handle(req, res) {
  const d = describeRequest(req);
  logLine(d);
  const url = new URL(req.url, 'http://origin.invalid');
  const wantsHtml = (req.headers.accept ?? '').includes('text/html');
  if (url.pathname === '/echo') {
    return wantsHtml ? send(res, 200, 'text/html; charset=utf-8', echoHtml(d)) : json(res, 200, d);
  }
  if (url.pathname === '/g6' && req.method === 'GET') {
    return send(res, 200, 'text/html; charset=utf-8', g6Page(d, url.searchParams.get('variant')));
  }
  if (url.pathname === '/g6/upload' && req.method === 'POST') return countUpload(req, res);
  if (url.pathname === '/expiry' && req.method === 'GET') {
    return send(res, 200, 'text/html; charset=utf-8', expiryPage());
  }
  return json(res, 404, { error: 'not_found', path: req.url });
}

/** Builds the echo server without listening. Closing it also closes the WebSocket server. */
export function createEchoServer() {
  const server = http.createServer(handle);
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const d = describeRequest(req);
    logLine(d);
    if (new URL(req.url, 'http://origin.invalid').pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ kind: 'upgrade', requestLine: d.requestLine, httpVersion: d.httpVersion, headers: d.headers }));
      ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
    });
  });
  server.on('close', () => wss.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bind = process.env.BIND || '127.0.0.1';
  const port = Number(process.env.PORT || 3890);
  createEchoServer().listen(port, bind, () => {
    process.stdout.write(`echo-origin listening on http://${bind}:${port}\n`);
  });
}
