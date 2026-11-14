/**
 * The three Deploy-time secrets (D20): presence and shape validation, and the
 * constant-time setup-code comparison.
 *
 * | Secret         | Purpose                       | Valid when                              |
 * | `CF_API_TOKEN` | Cloudflare API calls (05)     | optional; non-blank when set            |
 * | `SETUP_CODE`   | first-run gate (07)           | at least 24 characters                  |
 * | `DATA_KEY`     | root of encryption at rest    | base64 decoding to at least 32 bytes    |
 *
 * When one is missing or malformed the pipeline refuses every route but `/v1/meta` and the
 * setup wizard (which explains the problem itself) with `503 unavailable`, and logs the
 * secret's NAME (never its value) once per isolate. `CF_API_TOKEN` may be absent: setup
 * stores the token sealed in D1, its one home from then on (07), and the deployer may
 * delete the secret.
 *
 * <module-headers:begin>
 * Uses:
 * src/security/secrets.ts
 * ├── src/env.ts
 * └── src/log/logger.ts
 * External: none
 *
 * Used by:
 * src/security/secrets.ts
 * ├── src/http/pipeline.ts
 * ├── src/routes/phase07-context.ts
 * ├── src/security/data-key.ts
 * ├── src/setup/setup-gate.ts
 * └── test/secrets.test.ts
 * <module-headers:end>
 */
import type { Env } from "../env.ts";
import type { Logger } from "../log/logger.ts";

export type SecretName = "CF_API_TOKEN" | "SETUP_CODE" | "DATA_KEY";
export interface SecretProblem {
  name: SecretName;
  problem: "missing" | "malformed";
}

export const SETUP_CODE_MIN_LENGTH = 24;
export const DATA_KEY_MIN_BYTES = 32;

/** Decodes a DATA_KEY-style value (standard base64), or null when it is not one. */
export function decodeDataKey(value: string | undefined): Uint8Array | null {
  if (!value) return null;
  try {
    const bin = atob(value.trim());
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return bytes.length >= DATA_KEY_MIN_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

/** Every missing or malformed secret, in a fixed order. */
export function secretProblems(env: Env): SecretProblem[] {
  const out: SecretProblem[] = [];
  const check = (name: SecretName, value: string | undefined, valid: (v: string) => boolean) => {
    if (value === undefined || value === "") out.push({ name, problem: "missing" });
    else if (!valid(value)) out.push({ name, problem: "malformed" });
  };
  if (env.CF_API_TOKEN !== undefined && env.CF_API_TOKEN !== "") check("CF_API_TOKEN", env.CF_API_TOKEN, (v) => v.trim().length > 0);
  check("SETUP_CODE", env.SETUP_CODE, (v) => v.length >= SETUP_CODE_MIN_LENGTH);
  check("DATA_KEY", env.DATA_KEY, (v) => decodeDataKey(v) !== null);
  return out;
}

const reported = new Set<string>();

/** True when every secret is usable; otherwise logs each problem once per isolate. */
export function secretsUsable(env: Env, log: Logger): boolean {
  const problems = secretProblems(env);
  for (const p of problems) {
    const key = `${p.name}:${p.problem}`;
    if (reported.has(key)) continue;
    reported.add(key);
    log.error("secret_unusable", {
      secret_name: p.name,
      problem: p.problem,
      action: `Set the ${p.name} secret on this Worker (dashboard or wrangler secret put), then retry.`,
    });
  }
  return problems.length === 0;
}

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

/** Constant-time setup-code check: SHA-256 of both sides, then timingSafeEqual. */
export async function setupCodeMatches(env: Env, candidate: string): Promise<boolean> {
  const expected = env.SETUP_CODE;
  if (!expected || expected.length < SETUP_CODE_MIN_LENGTH) return false;
  const [a, b] = await Promise.all([sha256(expected), sha256(candidate)]);
  return crypto.subtle.timingSafeEqual(a, b);
}
