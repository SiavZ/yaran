/**
 * WebSocket probe: opens one WebSocket through Access and cloudflared and reports what happened.
 *
 * Gates G1, G2, G3 and G12 need a scriptable client that sends chosen headers (an Access
 * JWT, a CF_Authorization cookie, a service token) on the upgrade request and reports the
 * handshake status and whether the echo origin's /ws answered. Without --hold it does one
 * round trip and prints a single JSON line; with --hold it keeps the socket open for the
 * expiry gates and prints one JSON line per event plus a summary.
 *
 * - Header values come only from --headers-file and are never printed; nor is message content,
 *   because the origin's upgrade message echoes those same headers back.
 * - Exit 0 means echoed (single shot) or opened (hold); any other outcome exits 1, bad usage 2.
 * - Output is flushed before exit, because stdout to a pipe is asynchronous on macOS.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:crypto, node:fs, ws
 *
 * Used by: entry point (node ws-probe.mjs, run by the tools/cloud-gates gate scripts and test/echo-origin.test.mjs)
 * <module-headers:end>
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const USAGE =
  'usage: node ws-probe.mjs <wss-url> [--headers-file <path>] [--timeout <ms>] [--hold <seconds>] [--ping-every <seconds>]';

function finish(obj, code) {
  process.stdout.write(`${JSON.stringify(obj)}\n`, () => process.exit(code));
}

function parseArgs(argv) {
  const opts = { url: null, headersFile: null, timeout: 8000, hold: null, pingEvery: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--headers-file') opts.headersFile = next();
    else if (a === '--timeout') opts.timeout = Number(next());
    else if (a === '--hold') opts.hold = Number(next());
    else if (a === '--ping-every') opts.pingEvery = Number(next());
    else if (!a.startsWith('--') && opts.url === null) opts.url = a;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.url) throw new Error('missing url');
  for (const k of ['timeout', 'pingEvery']) {
    if (!(opts[k] > 0)) throw new Error(`--${k} must be a positive number`);
  }
  if (opts.hold !== null && !(opts.hold > 0)) throw new Error('--hold must be a positive number');
  return opts;
}

/** Reads raw `Name: value` lines; blank lines and `#` comments are skipped. */
function readHeaders(path) {
  const headers = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error('headers file has a line without "Name: value"');
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return headers;
}

function singleShot(ws, opts) {
  const result = { status: null, opened: false, firstMessageKind: null, echoed: false };
  const token = `probe-${randomBytes(6).toString('hex')}`;
  let first = true;
  let ended = false;
  const done = (error) => {
    if (ended) return;
    ended = true;
    if (error) result.error = error;
    finish(result, result.echoed ? 0 : 1);
  };
  setTimeout(() => done('timeout waiting for the echo'), opts.timeout).unref();
  ws.on('upgrade', (res) => {
    result.status = res.statusCode;
  });
  ws.on('unexpected-response', (_req, res) => {
    result.status = res.statusCode;
    done('unexpected-response');
  });
  ws.on('open', () => {
    result.opened = true;
  });
  ws.on('message', (data) => {
    const text = data.toString();
    if (first) {
      first = false;
      try {
        result.firstMessageKind = JSON.parse(text).kind ?? null;
      } catch {
        result.firstMessageKind = 'non-json';
      }
      ws.send(token);
      return;
    }
    if (text === token) {
      result.echoed = true;
      ws.close(1000, 'probe done');
    }
  });
  ws.on('close', () => done(result.echoed ? undefined : 'closed before the echo'));
  ws.on('error', (err) => done(err.message));
}

function hold(ws, opts) {
  const summary = { summary: true, opened: false, closedAt: null, closeCode: null, lastMessageAt: null };
  const emit = (obj) => process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...obj })}\n`);
  let pinger = null;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    clearInterval(pinger);
    finish(summary, summary.opened ? 0 : 1);
  };
  ws.on('unexpected-response', (_req, res) => {
    emit({ event: 'unexpected-response', status: res.statusCode });
    end();
  });
  ws.on('open', () => {
    summary.opened = true;
    emit({ event: 'open' });
    let n = 0;
    pinger = setInterval(() => ws.send(`hold-ping-${++n}`), opts.pingEvery * 1000);
    setTimeout(() => ws.close(1000, 'hold elapsed'), opts.hold * 1000).unref();
  });
  ws.on('message', () => {
    summary.lastMessageAt = new Date().toISOString();
    emit({ event: 'message' });
  });
  ws.on('close', (code, reason) => {
    summary.closedAt = new Date().toISOString();
    summary.closeCode = code;
    emit({ event: 'close', code, reason: reason.toString() });
    end();
  });
  ws.on('error', (err) => {
    emit({ event: 'error', reason: err.message });
    if (!summary.opened) end();
  });
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
  opts.headers = opts.headersFile ? readHeaders(opts.headersFile) : {};
} catch (err) {
  process.stderr.write(`${err.message}\n${USAGE}\n`);
  process.exit(2);
}
const ws = new WebSocket(opts.url, { headers: opts.headers, handshakeTimeout: opts.timeout });
if (opts.hold === null) singleShot(ws, opts);
else hold(ws, opts);
