/**
 * Typed facade over Phase 15's native org API client for the three calls the shell makes.
 *
 * `GET /v1/me` (W9), `GET /v1/me/machines` (W10, all pages) and `DELETE /v1/me/machines/{id}`
 * (W11, 202 `TeardownStarted`) all go through `Session.request`, so no credential and no
 * network ever touch JS (D22). Responses are validated against the generated Phase 02 types;
 * error envelopes are interpreted by `@yaran/protocol` and turned into one sentence each,
 * with an unknown code still named in its sentence.
 *
 * - A `device_revoked` result is surfaced as its own failure: the native client has already
 *   deleted the org's sessions; the caller removes the org and shows the phone-removed state.
 * - Text from the org (messages, names) is never rendered as HTML.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/api.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/lib/assertNever.ts
 * ├── src/lib/diagnostics.ts
 * ├── src/lib/native/machineView.ts
 * └── src/lib/protocolCompat.ts
 * External: @lingui/core
 *
 * Used by:
 * src/lib/api.ts
 * ├── src/lib/api.test.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/machines/RemoveMachineDialog.tsx
 * ├── src/screens/machines/states/ErrorState.tsx
 * └── src/screens/onboarding/ConfirmOrg.tsx
 * <module-headers:end>
 */
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { interpretError, validate, type MachinePage, type MachineSummary, type Me, type Meta, type TeardownStarted } from '@yaran/protocol';

import { assertNever } from './assertNever.ts';
import { log } from './diagnostics.ts';
import { Session, type ApiResult } from './native/machineView.ts';
import { updateFor } from './protocolCompat.ts';

export type ApiFailure =
  | { kind: 'session_expired' }
  | { kind: 'device_revoked' }
  | { kind: 'offline' }
  | { kind: 'tls_error'; host: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'protocol_unsupported'; update: 'client' | 'server' }
  | { kind: 'api_error'; code: string; known: boolean; status: number; requestId: string | null }
  | { kind: 'invalid_response'; status: number };

export type ApiOutcome<T> = { ok: true; value: T } | { ok: false; failure: ApiFailure };

/** A page cap so a misbehaving server cannot make the shell loop forever. */
export const MAX_MACHINE_PAGES = 20;

// Maps a native result to a validated value or a failure; `orgId` names the host in a TLS failure.
function interpret<T>(result: ApiResult, typeName: string, okStatus: number[], orgId: string): ApiOutcome<T> {
  switch (result.kind) {
    case 'ok': {
      if (!okStatus.includes(result.status) || !validate(typeName, result.body).valid) {
        log('warn', `org API answered ${result.status} with a body that is not a ${typeName}`);
        return { ok: false, failure: { kind: 'invalid_response', status: result.status } };
      }
      return { ok: true, value: result.body as T };
    }
    case 'api_error': {
      const e = interpretError(result.status, result.error);
      const code = e.code === 'unknown' ? (e.rawCode ?? `HTTP ${result.status}`) : e.code;
      return { ok: false, failure: { kind: 'api_error', code, known: e.code !== 'unknown', status: result.status, requestId: e.requestId } };
    }
    case 'session_expired':
    case 'device_revoked':
    case 'offline':
      return { ok: false, failure: { kind: result.kind } };
    case 'tls_error':
      return { ok: false, failure: { kind: 'tls_error', host: new URL(orgId).hostname } };
    case 'refused':
      return { ok: false, failure: { kind: 'refused', reason: result.reason } };
    case 'protocol_unsupported':
      return { ok: false, failure: { kind: 'protocol_unsupported', update: updateFor(result) } };
    default:
      return assertNever(result);
  }
}

export async function getMe(orgId: string): Promise<ApiOutcome<Me>> {
  return interpret<Me>(await Session.request({ orgId, method: 'GET', path: '/v1/me' }), 'Me', [200], orgId);
}

/** Every machine of the signed-in user, following `next_cursor`. */
export async function listMachines(orgId: string): Promise<ApiOutcome<MachineSummary[]>> {
  const all: MachineSummary[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_MACHINE_PAGES; page++) {
    const path: string = cursor === null ? '/v1/me/machines' : `/v1/me/machines?cursor=${encodeURIComponent(cursor)}`;
    const got = interpret<MachinePage>(await Session.request({ orgId, method: 'GET', path }), 'MachinePage', [200], orgId);
    if (!got.ok) return got;
    all.push(...got.value.items);
    cursor = got.value.next_cursor;
    if (cursor === null) return { ok: true, value: all };
  }
  log('warn', `machine list stopped after ${MAX_MACHINE_PAGES} pages`);
  return { ok: true, value: all };
}

/** Starts the teardown of one machine; a 404 means it is already gone. */
export async function removeMachine(orgId: string, machineId: string): Promise<ApiOutcome<TeardownStarted | 'already_gone'>> {
  const result = await Session.request({ orgId, method: 'DELETE', path: `/v1/me/machines/${encodeURIComponent(machineId)}` });
  if (result.kind === 'api_error' && result.status === 404) return { ok: true, value: 'already_gone' };
  return interpret<TeardownStarted>(result, 'TeardownStarted', [202], orgId);
}

/** Why the public `/v1/meta` fetch failed; each has its own sentence on Confirm org. */
export type MetaFailure = 'offline' | 'tls_error' | 'not_json' | 'access_redirect' | 'invalid' | 'refused';

/** `GET <orgUrl>/v1/meta` through the native client, validated as a 02 `Meta`. */
export async function getMeta(orgUrl: string): Promise<{ ok: true; meta: Meta } | { ok: false; code: MetaFailure }> {
  const result = await Session.meta({ orgUrl });
  switch (result.kind) {
    case 'ok':
      return result.status === 200 && validate('Meta', result.body).valid ? { ok: true, meta: result.body as Meta } : { ok: false, code: 'invalid' };
    case 'offline':
    case 'tls_error':
      return { ok: false, code: result.kind };
    // The native client turns a redirect toward Access (or an envelope-less 401/403) into this.
    case 'session_expired':
      return { ok: false, code: 'access_redirect' };
    case 'refused':
      return { ok: false, code: result.reason === 'not_json' ? 'not_json' : 'refused' };
    case 'api_error':
    case 'device_revoked':
    case 'protocol_unsupported':
      return { ok: false, code: 'invalid' };
    default:
      return assertNever(result);
  }
}

// Sentences for the envelope codes these three routes document; anything else is generic.
function codeMessage(code: string, known: boolean): MessageDescriptor {
  switch (code) {
    case 'unauthenticated':
      return msg`Your sign-in to this org has ended. Sign in again to continue.`;
    case 'user_disabled':
      return msg`Your account in this org is disabled. Ask your admin to turn it back on.`;
    case 'forbidden':
      return msg`Your account isn't allowed to do that in this org.`;
    case 'rate_limited':
      return msg`Too many requests in a short time. Wait a minute and try again.`;
    case 'setup_incomplete':
      return msg`This control plane hasn't finished setup yet. Ask your admin to finish the setup page, then try again.`;
    case 'identity_unavailable':
    case 'unavailable':
    case 'cloudflare_unavailable':
      return msg`The control plane is temporarily unavailable. Try again in a few minutes.`;
    case 'internal':
      return msg`The control plane hit an internal error. Try again; if it keeps happening, tell your admin.`;
    default:
      return known
        ? msg`The control plane refused the request (${code}). Try again, or tell your admin if it keeps happening.`
        : msg`The control plane answered with an error this app doesn't know (${code}). Updating the app may help.`;
  }
}

/** One sentence per failure, for error states and toasts. */
export function failureMessage(failure: ApiFailure): MessageDescriptor {
  switch (failure.kind) {
    case 'session_expired':
      return msg`Your sign-in to this org has ended. Sign in again to continue.`;
    case 'device_revoked':
      return msg`This phone was removed from the org, so its sign-ins were deleted. Add the org again to keep using it.`;
    case 'offline':
      return msg`No connection. Check your network and try again.`;
    case 'tls_error': {
      const host = failure.host;
      return msg`The connection to ${host} isn't secure, so the app stopped.`;
    }
    case 'refused':
      return msg`The app refused to send that request because it broke a safety rule. Update the app if this keeps happening.`;
    case 'protocol_unsupported':
      return failure.update === 'client'
        ? msg`This app is too old for the org's control plane. Update the app.`
        : msg`The org's control plane is too old for this app. Ask your admin to update it.`;
    case 'api_error':
      return codeMessage(failure.code, failure.known);
    case 'invalid_response':
      return msg`The control plane sent an answer this app couldn't read. Updating the app may help.`;
    default:
      return assertNever(failure);
  }
}
