/**
 * Domain probe Worker: attaches its own custom domain and disables its own workers.dev route for gate G14.
 *
 * Mirrors the shipped deploy tree's first run (workers_dev on, preview URLs off, no route
 * in the config): the operator opens /setup on the workers.dev URL, pastes a token, and the
 * Worker calls the Cloudflare API itself. Every request first passes the host lock, so the
 * same deployment also measures step 8 (the lock before and after setup closes).
 *
 * - Never logs form bodies; the pasted token is used for one outbound call and dropped.
 * - SETUP_STATE and CP_HOST come from vars the gate script overrides with --var.
 * - Refusals use the cloud protocol error envelope; the 421 body names no host.
 *
 * <module-headers:begin>
 * Uses:
 * src/index.ts
 * ├── src/host-lock.ts
 * └── src/setup.ts
 * External: none
 *
 * Used by: entry point (Cloudflare Worker, deployed by tools/cloud-gates/g14-custom-domain.sh)
 * <module-headers:end>
 */
import { hostLock, parseSetupState } from './host-lock';
import { attachDomain, setSubdomain, validateAttach, validateSubdomain } from './setup';

export interface Env {
  SETUP_STATE: string;
  CP_HOST: string;
}

function requestId(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function refuse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, retryable: false }, request_id: requestId() }, { status });
}

const SETUP_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>yaran gate G14 setup</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:1rem auto;padding:0 1rem}
label{display:block;margin:.5rem 0}input{width:100%;box-sizing:border-box;padding:.4rem}
fieldset{margin:1rem 0}button{padding:.5rem 1rem}</style></head><body>
<h1>yaran gate G14</h1>
<p>Paste a test token. It is sent once to api.cloudflare.com and is not stored or logged.</p>
<form method="post" action="/setup/attach"><fieldset><legend>Attach a custom domain</legend>
<label>API token <input name="token" type="password" autocomplete="off" required></label>
<label>Account ID <input name="account_id" required></label>
<label>Zone ID <input name="zone_id" required></label>
<label>Hostname <input name="hostname" required></label>
<label>Worker (service) <input name="service" value="yaran-gate-domain-probe" required></label>
<button type="submit">Attach</button></fieldset></form>
<form method="post" action="/setup/subdomain"><fieldset><legend>workers.dev route</legend>
<label>API token <input name="token" type="password" autocomplete="off" required></label>
<label>Account ID <input name="account_id" required></label>
<label>Worker (script) <input name="script" value="yaran-gate-domain-probe" required></label>
<label>enabled <select name="enabled"><option>false</option><option>true</option></select></label>
<label>previews_enabled <select name="previews_enabled"><option>false</option><option>true</option></select></label>
<button type="submit">Update</button></fieldset></form></body></html>`;

async function readForm(request: Request): Promise<FormData | null> {
  try {
    return await request.formData();
  } catch {
    return null;
  }
}

async function route(request: Request, env: Env, pathname: string): Promise<Response> {
  if (pathname === '/v1/meta') {
    if (request.method !== 'GET') return refuse(405, 'method_not_allowed', 'Use GET for /v1/meta.');
    return Response.json({ setup: parseSetupState(env.SETUP_STATE) });
  }
  if (pathname === '/setup') {
    if (request.method !== 'GET') return refuse(405, 'method_not_allowed', 'Use GET for /setup.');
    return new Response(SETUP_PAGE, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    });
  }
  if (pathname === '/setup/attach' || pathname === '/setup/subdomain') {
    if (request.method !== 'POST') return refuse(405, 'method_not_allowed', `Use POST for ${pathname}.`);
    const form = await readForm(request);
    if (!form) return refuse(400, 'validation_failed', 'The body must be a submitted form.');
    try {
      if (pathname === '/setup/attach') {
        const input = validateAttach(form);
        return input.ok ? Response.json(await attachDomain(input.value)) : refuse(400, 'validation_failed', input.message);
      }
      const input = validateSubdomain(form);
      return input.ok ? Response.json(await setSubdomain(input.value)) : refuse(400, 'validation_failed', input.message);
    } catch {
      return refuse(502, 'upstream_unreachable', 'The Cloudflare API could not be reached from the Worker.');
    }
  }
  return refuse(404, 'not_found', 'No such route on this probe.');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const verdict = hostLock(url.host, url.pathname, parseSetupState(env.SETUP_STATE), env.CP_HOST);
    if (!verdict.allow) return refuse(verdict.status, verdict.code, verdict.message);
    return route(request, env, url.pathname);
  },
} satisfies ExportedHandler<Env>;
