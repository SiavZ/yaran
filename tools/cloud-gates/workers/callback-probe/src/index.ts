/**
 * Callback probe Worker: association files, a handoff consent page and an unclaimed-callback page for gate G13.
 *
 * Attached by the gate script to both the callback host (association files and
 * /auth/callback) and a separate consent host, so the consent page's 303 is cross-origin
 * exactly as in production. If the OS hands the verified https callback to the app, the
 * browser never loads /auth/callback; if the page renders, the app did NOT claim the link.
 *
 * - Serves every route on any host; host-specific behaviour is the gate's to observe.
 * - Echoes no query value on the callback pages and logs nothing.
 * - Refusals use the cloud protocol error envelope and never redirect.
 *
 * <module-headers:begin>
 * Uses:
 * src/index.ts
 * ├── src/association.ts
 * └── src/handoff.ts
 *     └── src/association.ts
 * External: (none)
 *
 * Used by:
 * src/index.ts
 * └── entry point (Cloudflare Worker, deployed by tools/cloud-gates/g13-system-browser-auth.sh)
 * <module-headers:end>
 */
import { appleAppSiteAssociation, assetLinks, CALLBACK_PATHS } from './association';
import { consentCsp, consentPage, decisionLocation, parseDecision, validateHandoff, type HandoffConfig } from './handoff';

export interface Env {
  CALLBACK_HOST: string;
  ANDROID_PACKAGE: string;
  ANDROID_CERT_SHA256: string;
  APPLE_APP_ID: string;
  DEV_SCHEME: string;
}

function requestId(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function refuse(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message, retryable: false }, request_id: requestId() },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

const html = (body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers } });

const CALLBACK_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Callback not claimed</title></head>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem">
<h1>Callback not claimed</h1>
<p>If you can read this page, the app did NOT claim the verified link: the operating system
let the browser load the callback instead of handing it to the app.</p></body></html>`;

async function handoff(request: Request, env: Env): Promise<Response> {
  const cfg: HandoffConfig = { callbackHost: env.CALLBACK_HOST, devScheme: env.DEV_SCHEME || 'yaranapp-gate' };
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const checked = validateHandoff(url.searchParams, cfg, true);
    if (!checked.ok) return refuse(400, 'validation_failed', checked.message);
    return html(consentPage(checked.value, url.host), {
      'referrer-policy': 'same-origin',
      'content-security-policy': consentCsp(checked.value.build, cfg),
    });
  }
  if (request.method !== 'POST') return refuse(405, 'method_not_allowed', 'Use GET or POST for /v1/handoff.');
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return refuse(400, 'validation_failed', 'The body must be a submitted form.');
  }
  const checked = validateHandoff(form, cfg, false);
  if (!checked.ok) return refuse(400, 'validation_failed', checked.message);
  const decision = parseDecision(form.get('decision'));
  if (!decision) return refuse(400, 'validation_failed', 'decision must be "continue" or "cancel".');
  return new Response(null, {
    status: 303,
    headers: { location: decisionLocation(checked.value, decision), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/v1/handoff') return handoff(request, env);
    if (request.method !== 'GET') return refuse(405, 'method_not_allowed', 'Use GET for this route.');
    if (pathname === '/.well-known/assetlinks.json') {
      return Response.json(assetLinks(env.ANDROID_PACKAGE, env.ANDROID_CERT_SHA256));
    }
    if (pathname === '/.well-known/apple-app-site-association') {
      return Response.json(appleAppSiteAssociation(env.APPLE_APP_ID));
    }
    if ((CALLBACK_PATHS as readonly string[]).includes(pathname)) return html(CALLBACK_PAGE);
    return refuse(404, 'not_found', 'No such route on this probe.');
  },
} satisfies ExportedHandler<Env>;
