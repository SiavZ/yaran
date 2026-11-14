/**
 * The relay's configuration, parsed once from the runtime's environment (Worker vars and
 * secrets, or the Node process environment) into typed values.
 *
 * Vars: PUBLIC_ORIGIN, APNS_TEAM_ID, APNS_KEY_ID, APNS_TOPICS, ALLOWED_ENVIRONMENTS and, for
 * the G5 fallback only, FCM_PROJECT_ID and FCM_APP_IDS. Secrets: APNS_P8, ENDPOINT_KEYS
 * (`{"current": kid, "keys": {kid: base64url of 32 bytes}}`) and, for G5 only,
 * FCM_SERVICE_ACCOUNT. Nothing here is ever logged.
 *
 * - Throws a message naming the setting (never its value) when one is missing or malformed.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/core/config.ts
 * ├── src/apns/client.ts
 * ├── src/core/deps.ts
 * ├── src/core/endpoint_codec.ts
 * ├── src/runtime/node.ts
 * ├── src/runtime/worker.ts
 * └── test/helpers/runtimes.ts
 * <module-headers:end>
 */
export type ApnsEnvironment = "production" | "sandbox";

export interface RelayConfig {
  publicOrigin: string;
  apns: { teamId: string; keyId: string; p8: string; topics: string[]; environments: ApnsEnvironment[] };
  /** Present only when the G5 fallback (fcm_relay) is deployed. */
  fcm: { projectId: string; appIds: string[]; serviceAccount: string } | null;
  endpointKeys: string;
}

export type EnvLike = Record<string, unknown>;

function need(env: EnvLike, name: string): string {
  const v = env[name];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`relay setting ${name} is missing`);
  return v.trim();
}

const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

export function parseConfig(env: EnvLike): RelayConfig {
  const publicOrigin = need(env, "PUBLIC_ORIGIN");
  if (!/^https:\/\/[^/:?#]+$/.test(publicOrigin)) throw new Error("relay setting PUBLIC_ORIGIN must be an https origin with no path or port");
  const environments = list(need(env, "ALLOWED_ENVIRONMENTS"));
  if (environments.length === 0 || !environments.every((e) => e === "production" || e === "sandbox")) {
    throw new Error("relay setting ALLOWED_ENVIRONMENTS must list production and/or sandbox");
  }
  const projectId = typeof env.FCM_PROJECT_ID === "string" ? env.FCM_PROJECT_ID.trim() : "";
  return {
    publicOrigin,
    apns: {
      teamId: need(env, "APNS_TEAM_ID"),
      keyId: need(env, "APNS_KEY_ID"),
      p8: need(env, "APNS_P8"),
      topics: list(need(env, "APNS_TOPICS")),
      environments: environments as ApnsEnvironment[],
    },
    fcm: projectId ? { projectId, appIds: list(need(env, "FCM_APP_IDS")), serviceAccount: need(env, "FCM_SERVICE_ACCOUNT") } : null,
    endpointKeys: need(env, "ENDPOINT_KEYS"),
  };
}
