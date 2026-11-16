/**
 * The Worker's environment: the bindings `wrangler types` generates plus the secrets and
 * vars it cannot see, and the presence checks for bindings a deploy may legitimately lack.
 *
 * Secrets are typed optional on purpose: a deploy can be missing one, and `secrets.ts`
 * turns that into a refusal rather than a crash. The rate-limit bindings may be absent
 * (plan availability is UNVERIFIED), so they are read through `rateLimitBinding`.
 *
 * - Secret values are never logged; only their names are.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/env.ts
 * ├── src/console/route-types.ts
 * ├── src/http/context.ts
 * ├── src/http/pipeline.ts
 * ├── src/index.ts
 * ├── src/routes/call.ts
 * ├── src/scheduled/dispatcher.ts
 * ├── src/security/rate-limit.ts
 * └── src/security/secrets.ts
 * <module-headers:end>
 */

declare global {
  // Augmenting wrangler's generated Cloudflare.Env is how a Worker types bindings it cannot see.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      /** Cloudflare API token (Phase 05 uses it; 07 verifies it live). */
      CF_API_TOKEN?: string | undefined;
      /** First-run setup gate (07). */
      SETUP_CODE?: string | undefined;
      /** Root of encryption at rest: base64 of at least 32 bytes. */
      DATA_KEY?: string | undefined;
      /** The previous DATA_KEY during a rotation; opens old rows only. */
      DATA_KEY_PREVIOUS?: string | undefined;
      /** Cloudflare API base URL override (05; Phase 19 staging chaos proxy). Must be https. */
      CF_API_BASE_URL?: string | undefined;
      /** Space- or comma-separated https app callback URLs (02 §8; 06 handoff, 05 G1 fallback L2). */
      APP_CALLBACK_URLS?: string | undefined;
      /** "off" disables the runtime migrator (G11 fallback); anything else leaves it on. */
      RUNTIME_MIGRATIONS?: string | undefined;
    }
  }
}

export type Env = Cloudflare.Env;

export type RateLimitName = "RL_IP" | "RL_AUTH" | "RL_MACHINE";

/** The rate-limit binding, or undefined when this deploy has none (tier-2 fallback). */
export function rateLimitBinding(env: Env, name: RateLimitName): RateLimit | undefined {
  const binding = (env as unknown as Record<string, unknown>)[name] as RateLimit | undefined;
  return binding && typeof binding.limit === "function" ? binding : undefined;
}
