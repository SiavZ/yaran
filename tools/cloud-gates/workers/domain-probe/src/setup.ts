/**
 * Setup actions for gate G14: validate the pasted form and call the Cloudflare API from inside the Worker.
 *
 * G14 asks which token permissions let a deployed Worker attach its own custom domain
 * (PUT /accounts/{id}/workers/domains) and disable its own workers.dev route
 * (POST /accounts/{id}/workers/scripts/{script}/subdomain). The operator pastes a token into
 * the setup form so it never sits in argv or shell history; this module checks every field
 * and reduces Cloudflare's answer to the envelope fields the evidence needs.
 *
 * - The token is used for the one outbound call and never returned, logged or echoed.
 * - Every id and name is validated against a strict charset before it reaches a URL.
 * - Cloudflare's messages are truncated to 300 characters; a non-JSON answer is reported, not thrown.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/setup.ts
 * ├── src/index.ts
 * └── test/setup.test.ts
 * <module-headers:end>
 */

export interface AttachInput {
  token: string;
  accountId: string;
  zoneId: string;
  hostname: string;
  service: string;
}

export interface SubdomainInput {
  token: string;
  accountId: string;
  script: string;
  enabled: boolean;
  previewsEnabled: boolean;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

export interface CfSummary {
  httpStatus: number;
  success: boolean;
  errors: { code: number | null; message: string }[];
  messages: unknown[];
  result: unknown;
}

type Form = { get(name: string): unknown };

const ID = /^[0-9a-f]{32}$/;
const TOKEN = /^[A-Za-z0-9_.-]{20,200}$/;
const SCRIPT = /^[a-z0-9](?:[a-z0-9_-]{0,62})$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const API = 'https://api.cloudflare.com/client/v4';

const field = (form: Form, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

function bool(form: Form, name: string): boolean | null {
  const v = field(form, name);
  return v === 'true' ? true : v === 'false' ? false : null;
}

function common(form: Form): Validated<{ token: string; accountId: string }> {
  const token = field(form, 'token');
  const accountId = field(form, 'account_id').toLowerCase();
  if (!TOKEN.test(token)) return { ok: false, message: 'token must be 20 to 200 letters, digits, dots, dashes or underscores.' };
  if (!ID.test(accountId)) return { ok: false, message: 'account_id must be 32 hexadecimal characters.' };
  return { ok: true, value: { token, accountId } };
}

export function validateAttach(form: Form): Validated<AttachInput> {
  const base = common(form);
  if (!base.ok) return base;
  const zoneId = field(form, 'zone_id').toLowerCase();
  const hostname = field(form, 'hostname').toLowerCase();
  const service = field(form, 'service');
  if (!ID.test(zoneId)) return { ok: false, message: 'zone_id must be 32 hexadecimal characters.' };
  if (!HOSTNAME.test(hostname)) return { ok: false, message: 'hostname must be a fully qualified DNS name.' };
  if (!SCRIPT.test(service)) return { ok: false, message: 'service must be a Worker name: lowercase letters, digits, - or _.' };
  return { ok: true, value: { ...base.value, zoneId, hostname, service } };
}

export function validateSubdomain(form: Form): Validated<SubdomainInput> {
  const base = common(form);
  if (!base.ok) return base;
  const script = field(form, 'script');
  const enabled = bool(form, 'enabled');
  const previewsEnabled = bool(form, 'previews_enabled');
  if (!SCRIPT.test(script)) return { ok: false, message: 'script must be a Worker name: lowercase letters, digits, - or _.' };
  if (enabled === null || previewsEnabled === null) {
    return { ok: false, message: 'enabled and previews_enabled must each be "true" or "false".' };
  }
  return { ok: true, value: { ...base.value, script, enabled, previewsEnabled } };
}

const clip = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v) ?? '').slice(0, 300);

/** Reduces a Cloudflare v4 envelope to the fields G14 records. */
export function summarize(httpStatus: number, text: string): CfSummary {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return { httpStatus, success: false, errors: [{ code: null, message: `non-JSON response: ${clip(text)}` }], messages: [], result: null };
  }
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return {
    httpStatus,
    success: body.success === true,
    errors: errors.map((e) => {
      const rec = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>;
      return { code: typeof rec.code === 'number' ? rec.code : null, message: clip(rec.message ?? e) };
    }),
    messages: messages.map(clip),
    result: body.result ?? null,
  };
}

async function call(method: string, path: string, token: string, payload: unknown): Promise<CfSummary> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return summarize(res.status, await res.text());
}

export const attachDomain = (i: AttachInput): Promise<CfSummary> =>
  call('PUT', `/accounts/${i.accountId}/workers/domains`, i.token, {
    hostname: i.hostname,
    service: i.service,
    zone_id: i.zoneId,
  });

export const setSubdomain = (i: SubdomainInput): Promise<CfSummary> =>
  call('POST', `/accounts/${i.accountId}/workers/scripts/${i.script}/subdomain`, i.token, {
    enabled: i.enabled,
    previews_enabled: i.previewsEnabled,
  });
