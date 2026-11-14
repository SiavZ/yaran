/**
 * APNs probe Worker: sends alert pushes to APNs over fetch for gate G4.
 *
 * G4 asks whether a deployed Worker can reach APNs, which speaks HTTP/2 only, with plain
 * fetch. `POST /send` signs a provider JWT from the P8 secret, posts `count` alert pushes
 * sequentially to the sandbox (or production) host, and returns each status, apns-id and
 * body. A garbage token answered with BadDeviceToken proves APNs itself replied.
 *
 * - Never logs or returns the device token or the provider JWT.
 * - Requires the x-probe-key header (PROBE_KEY secret), compared in constant time, so a
 *   deployed probe cannot be used to spam a device.
 * - Refusals use the cloud protocol error envelope.
 *
 * <module-headers:begin>
 * Uses:
 * src/index.ts
 * └── src/apns-jwt.ts
 * External: none
 *
 * Used by: entry point (Cloudflare Worker, deployed by tools/cloud-gates/g04-apns.sh)
 * <module-headers:end>
 */
import { signProviderJwt } from './apns-jwt';

export interface Env {
  P8: string;
  KID: string;
  TEAM: string;
  TOPIC: string;
  PROBE_KEY: string;
}

interface SendRequest {
  token: string;
  count: number;
  sandbox: boolean;
}

interface SendResult {
  i: number;
  status: number;
  apnsId: string | null;
  body: string;
}

function requestId(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function refuse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, retryable: false }, request_id: requestId() }, { status });
}

/** Constant-time comparison: hashing first makes both inputs the same length. */
async function keyMatches(given: string | null, expected: string): Promise<boolean> {
  if (!given || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function parseSend(raw: unknown): SendRequest | string {
  if (typeof raw !== 'object' || raw === null) return 'The body must be a JSON object.';
  const body = raw as Record<string, unknown>;
  // Any alphanumeric string is accepted so G4's garbage-token control still reaches APNs.
  if (typeof body.token !== 'string' || !/^[A-Za-z0-9]{1,200}$/.test(body.token)) {
    return 'token must be 1 to 200 letters or digits.';
  }
  const count = body.count ?? 1;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 50) {
    return 'count must be an integer from 1 to 50.';
  }
  const sandbox = body.sandbox ?? true;
  if (typeof sandbox !== 'boolean') return 'sandbox must be a boolean.';
  return { token: body.token, count, sandbox };
}

async function send(env: Env, req: SendRequest): Promise<SendResult[]> {
  const jwt = await signProviderJwt(env.P8, env.KID, env.TEAM);
  const host = req.sandbox ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const results: SendResult[] = [];
  for (let i = 1; i <= req.count; i++) {
    const payload = {
      aps: { alert: { title: 'yaran gate G4', body: `APNs probe ${i}/${req.count}` }, 'mutable-content': 1 },
    };
    try {
      const res = await fetch(`https://${host}/3/device/${req.token}`, {
        method: 'POST',
        headers: {
          authorization: `bearer ${jwt}`,
          'apns-topic': env.TOPIC,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      results.push({ i, status: res.status, apnsId: res.headers.get('apns-id'), body: (await res.text()).slice(0, 300) });
    } catch (err) {
      // An error text that quotes the URL would carry the device token.
      const message = (err instanceof Error ? err.message : String(err)).split(req.token).join('<token>');
      results.push({ i, status: 0, apnsId: null, body: `fetch failed: ${message}`.slice(0, 300) });
    }
  }
  return results;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/send') return refuse(404, 'not_found', 'This probe only answers POST /send.');
    if (request.method !== 'POST') return refuse(405, 'method_not_allowed', 'Use POST for /send.');
    if (!(await keyMatches(request.headers.get('x-probe-key'), env.PROBE_KEY))) {
      return refuse(401, 'unauthenticated', 'The x-probe-key header is missing or wrong.');
    }
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return refuse(400, 'validation_failed', 'The body is not valid JSON.');
    }
    const parsed = parseSend(raw);
    if (typeof parsed === 'string') return refuse(400, 'validation_failed', parsed);
    let results: SendResult[];
    try {
      results = await send(env, parsed);
    } catch {
      return refuse(500, 'signing_failed', 'The provider JWT could not be signed; check the P8, KID and TEAM secrets.');
    }
    return Response.json({ results, errors: results.filter((r) => r.status !== 200).length });
  },
} satisfies ExportedHandler<Env>;
