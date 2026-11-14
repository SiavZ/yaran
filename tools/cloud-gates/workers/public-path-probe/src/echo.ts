/**
 * Path echo body for gate G8: what URL and path the Worker saw, and whether Access sent a JWT.
 *
 * G8 checks which paths on an Access-protected hostname reach the Worker without a login
 * (the public path overrides for /v1/meta and /v1/machine/*) and whether case or encoded
 * dot segments can slip a protected path through. Reporting both the raw request URL and
 * the WHATWG-parsed pathname makes any normalisation visible in the evidence.
 *
 * - Reports only the PRESENCE of Cf-Access-Jwt-Assertion and the email header, never values.
 * - Pure: builds a plain object from its inputs, so it is unit-testable in Node.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/echo.ts
 * ├── src/index.ts
 * └── test/echo.test.ts
 * <module-headers:end>
 */

export interface PathEcho {
  method: string;
  url: string;
  pathname: string;
  jwtPresent: boolean;
  emailHeaderPresent: boolean;
}

export function echoBody(method: string, url: string, headers: Headers): PathEcho {
  return {
    method,
    url,
    pathname: new URL(url).pathname,
    jwtPresent: headers.has('cf-access-jwt-assertion'),
    emailHeaderPresent: headers.has('cf-access-authenticated-user-email'),
  };
}
