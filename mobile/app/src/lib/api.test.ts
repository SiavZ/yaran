/**
 * Tests for the org API facade against Phase 02's shared fixtures.
 *
 * Valid fixture bodies parse; error envelopes map to sentences; an unknown code still names
 * the code; `device_revoked` and the transport outcomes surface as their own failures; paging
 * follows `next_cursor`; a 404 on remove means already gone.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/api.test.ts
 * ├── cloud/protocol/fixtures/api/ErrorEnvelope.json
 * ├── cloud/protocol/fixtures/api/MachinePage.json
 * ├── cloud/protocol/fixtures/api/Me.json
 * ├── src/lib/api.ts
 * ├── src/lib/i18n.ts
 * └── src/lib/native/machineView.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import machinePages from '@yaran/protocol/fixtures/api/MachinePage.json' with { type: 'json' };
import meFixture from '@yaran/protocol/fixtures/api/Me.json' with { type: 'json' };
import envelopes from '@yaran/protocol/fixtures/api/ErrorEnvelope.json' with { type: 'json' };
import { describe, expect, it, vi } from 'vitest';

import { failureMessage, getMe, listMachines, removeMachine, type ApiFailure } from './api.ts';
import { i18n } from './i18n.ts';
import { Session, type ApiResult } from './native/machineView.ts';

const request = vi.mocked(Session.request);
const answer = (...results: ApiResult[]) => results.forEach((r) => request.mockResolvedValueOnce(r));
const sentence = (f: ApiFailure) => i18n._(failureMessage(f));

describe('getMe', () => {
  it('parses every valid Me fixture', async () => {
    for (const v of meFixture.valid) {
      answer({ kind: 'ok', status: 200, body: v.value });
      expect(await getMe('https://cp.example.com')).toEqual({ ok: true, value: v.value });
    }
    expect(request).toHaveBeenCalledWith({ orgId: 'https://cp.example.com', method: 'GET', path: '/v1/me' });
  });
  it('refuses a body that is not a Me', async () => {
    answer({ kind: 'ok', status: 200, body: { hello: 'world' } });
    expect(await getMe('o')).toEqual({ ok: false, failure: { kind: 'invalid_response', status: 200 } });
  });
});

describe('listMachines', () => {
  it('follows next_cursor until the last page', async () => {
    const more = machinePages.valid.find((v) => v.value.next_cursor !== null)!.value;
    const last = machinePages.valid.find((v) => v.value.next_cursor === null)!.value;
    answer({ kind: 'ok', status: 200, body: more }, { kind: 'ok', status: 200, body: last });
    const got = await listMachines('o');
    expect(got.ok && got.value.length).toBe(more.items.length + last.items.length);
    expect(request.mock.calls[1]![0].path).toBe(`/v1/me/machines?cursor=${more.next_cursor}`);
  });
  it('surfaces device_revoked as its own failure', async () => {
    answer({ kind: 'device_revoked' });
    expect(await listMachines('o')).toEqual({ ok: false, failure: { kind: 'device_revoked' } });
  });
});

describe('removeMachine', () => {
  it('returns TeardownStarted on 202', async () => {
    answer({ kind: 'ok', status: 202, body: { machine_id: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b', state: 'tearing_down' } });
    const got = await removeMachine('o', '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b');
    expect(got).toEqual({ ok: true, value: { machine_id: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b', state: 'tearing_down' } });
    expect(request.mock.calls[0]![0]).toMatchObject({ method: 'DELETE', path: '/v1/me/machines/3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b' });
  });
  it('treats 404 as already gone', async () => {
    answer({ kind: 'api_error', status: 404, error: { error: { code: 'not_found', message: 'gone', retryable: false }, request_id: 'r' } });
    expect(await removeMachine('o', 'm')).toEqual({ ok: true, value: 'already_gone' });
  });
});

describe('error envelopes', () => {
  it('maps every valid envelope fixture to a sentence that is not empty', async () => {
    for (const v of envelopes.valid) {
      answer({ kind: 'api_error', status: 401, error: v.value });
      const got = await getMe('o');
      expect(got.ok).toBe(false);
      if (!got.ok) expect(sentence(got.failure).length).toBeGreaterThan(10);
    }
  });
  it('a known code gets its own sentence', async () => {
    answer({ kind: 'api_error', status: 429, error: { error: { code: 'rate_limited', message: 'slow', retryable: true }, request_id: 'r' } });
    const got = await getMe('o');
    expect(!got.ok && sentence(got.failure)).toMatch(/Too many requests/);
  });
  it('an unknown code still names the code', async () => {
    answer({ kind: 'api_error', status: 400, error: { error: { code: 'brand_new_code', message: 'x', retryable: false }, request_id: 'r' } });
    const got = await getMe('o');
    expect(!got.ok && sentence(got.failure)).toContain('brand_new_code');
  });
  it('a body that is no envelope names the status', async () => {
    // The native client never sends this; the shell still degrades to the status if it did.
    answer({ kind: 'api_error', status: 502, error: '<html>' as never });
    const got = await getMe('o');
    expect(!got.ok && sentence(got.failure)).toContain('HTTP 502');
  });
});

describe('failureMessage', () => {
  it('has a sentence for every transport failure', () => {
    const all: ApiFailure[] = [
      { kind: 'session_expired' },
      { kind: 'device_revoked' },
      { kind: 'offline' },
      { kind: 'tls_error', host: 'cp.example.com' },
      { kind: 'refused', reason: 'path' },
      { kind: 'protocol_unsupported', update: 'client' },
      { kind: 'protocol_unsupported', update: 'server' },
      { kind: 'invalid_response', status: 200 },
    ];
    for (const f of all) expect(sentence(f).length).toBeGreaterThan(10);
    expect(sentence({ kind: 'tls_error', host: 'cp.example.com' })).toContain('cp.example.com');
  });
});
