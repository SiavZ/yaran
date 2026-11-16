/**
 * R2 `POST /v1/endpoints`: seals an app's APNs (or, under the G5 fallback, FCM) token, app
 * id, the org's VAPID key and the registration id into a self-describing endpoint URL.
 *
 * Called from the app's native code. The body is 02's EndpointMintRequest; app_id must be
 * one the relay serves (400 relay_app_unknown); an fcm mint without the fcm channel, or an
 * APNs environment this deployment does not serve, is 400 validation_failed. The relay
 * stores nothing.
 *
 * <module-headers:begin>
 * Uses:
 * src/core/mint.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/core/deps.ts
 * ├── src/core/endpoint_codec.ts
 * └── src/core/http.ts
 * External: none
 *
 * Used by:
 * src/core/mint.ts
 * └── src/core/handler.ts
 * <module-headers:end>
 */
import { validate, type EndpointMintRequest } from "@yaran/protocol";
import type { RelayDeps } from "./deps.ts";
import { sealEndpoint, type EndpointClaims } from "./endpoint_codec.ts";
import { fail, json } from "./http.ts";

export function servedApps(deps: Pick<RelayDeps, "config">): string[] {
  return [...deps.config.apns.topics, ...(deps.config.fcm?.appIds ?? [])];
}

export async function mint(deps: RelayDeps, body: unknown, requestId: string): Promise<Response> {
  const checked = validate("EndpointMintRequest", body);
  if (!checked.valid) return fail("validation_failed", "The body does not match EndpointMintRequest.", requestId, { errors: checked.errors });
  const req = body as EndpointMintRequest;
  let claims: EndpointClaims;
  if (req.kind === "apns") {
    if (!deps.config.apns.topics.includes(req.app_id)) return fail("relay_app_unknown", "This relay does not serve that app.", requestId);
    if (!deps.config.apns.environments.includes(req.apns_environment)) {
      return fail("validation_failed", "This relay does not serve that APNs environment.", requestId);
    }
    claims = { p: "apns", t: req.apns_token, e: req.apns_environment, b: req.app_id, k: req.vapid_public_key, r: req.registration_id };
  } else {
    if (!deps.config.fcm) return fail("validation_failed", "This relay does not offer the fcm channel.", requestId);
    if (!deps.config.fcm.appIds.includes(req.app_id)) return fail("relay_app_unknown", "This relay does not serve that app.", requestId);
    claims = { p: "fcm", t: req.fcm_token, b: req.app_id, k: req.vapid_public_key, r: req.registration_id };
  }
  const endpoint = `${deps.config.publicOrigin}/w/${await sealEndpoint(deps.keys, claims)}`;
  if (!validate("EndpointMintResponse", { endpoint }).valid) {
    return fail("validation_failed", "The device token is too long to fit in an endpoint.", requestId);
  }
  deps.log("info", "relay.minted", { kind: claims.p, kid: deps.keys.current });
  return json(201, { endpoint }, requestId);
}
