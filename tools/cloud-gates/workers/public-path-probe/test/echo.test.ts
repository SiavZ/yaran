/**
 * Path echo normalisation tests: pins what WHATWG URL parsing does to G8's probe paths.
 *
 * The Worker runtime hands request.url through the same WHATWG parser, so these
 * assertions document which probes arrive unchanged and which collapse before routing:
 * case is preserved, `%2e%2e` is treated as `..` and resolved, extra segments survive.
 * Phase 04's canonical-path check is designed against this table.
 *
 * - Runs in plain Node (vitest); `Request` there uses the same WHATWG URL parser.
 *
 * <module-headers:begin>
 * Uses:
 * test/echo.test.ts
 * └── src/echo.ts
 * External: vitest
 *
 * Used by:
 * test/echo.test.ts
 * └── entry point (vitest)
 * <module-headers:end>
 */
import { describe, expect, it } from 'vitest';
import { echoBody } from '../src/echo';

const HOST = 'https://cp.example.invalid';

describe('echoBody normalisation', () => {
  it.each([
    ['/v1/MACHINE/claim', '/v1/MACHINE/claim'],
    ['/v1/machine/%2e%2e/me', '/v1/me'],
    ['/v1/machine/%2E%2e/me', '/v1/me'],
    ['/v1/machine/a/b', '/v1/machine/a/b'],
    ['/v1/meta/x', '/v1/meta/x'],
    ['/v1/machine/..%2fme', '/v1/machine/..%2fme'],
  ])('raw %s parses to pathname %s', (raw, pathname) => {
    const body = echoBody('GET', HOST + raw, new Headers());
    expect(body.url).toBe(HOST + raw);
    expect(body.pathname).toBe(pathname);
  });

  it('a Request has already resolved dot segments in its url', () => {
    const req = new Request(`${HOST}/v1/machine/%2e%2e/me`);
    expect(echoBody(req.method, req.url, req.headers).url).toBe(`${HOST}/v1/me`);
  });

  it('reports Access header presence without values', () => {
    const headers = new Headers({ 'Cf-Access-Jwt-Assertion': 'secret-jwt', 'Cf-Access-Authenticated-User-Email': 'a@example.invalid' });
    const body = echoBody('POST', `${HOST}/v1/machine/unpair`, headers);
    expect(body).toEqual({
      method: 'POST',
      url: `${HOST}/v1/machine/unpair`,
      pathname: '/v1/machine/unpair',
      jwtPresent: true,
      emailHeaderPresent: true,
    });
    expect(JSON.stringify(body)).not.toContain('secret-jwt');
    expect(echoBody('GET', `${HOST}/v1/meta`, new Headers()).jwtPresent).toBe(false);
  });
});
