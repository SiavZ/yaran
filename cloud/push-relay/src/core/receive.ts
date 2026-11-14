/**
 * R3 `POST /w/<endpoint>`: an org Worker's Web Push message, verified and re-wrapped for
 * APNs (or FCM under G5), with the push service's answer passed back so 410s reach the org.
 *
 * Order: open the endpoint (404 relay_endpoint_invalid); require Content-Encoding aes128gcm,
 * a TTL and valid Urgency/Topic (400 bad_request); body at most 2,900 bytes (413, a
 * documented deviation from RFC 8030's 4096 floor: base64 of the body plus the APNs JSON must
 * fit APNs' 4096); VAPID `k` equal to the embedded key (403 relay_vapid_mismatch) and a JWT
 * that verifies with aud = PUBLIC_ORIGIN and 0 < exp - now ≤ 24 h (401 relay_vapid_invalid);
 * per-org-key and per-device rate limits (429); then deliver and wait for the answer.
 *
 * - Logs outcome, upstream status and reason, kid, environment and the first 8 hex of
 *   SHA-256(VAPID key); never a token, endpoint, JWT or body.
 *
 * <module-headers:begin>
 * Uses:
 * src/core/receive.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/core/deps.ts
 * ├── src/core/endpoint_codec.ts
 * ├── src/core/http.ts
 * └── src/core/upstream.ts
 * External: none
 *
 * Used by:
 * src/core/receive.ts
 * └── src/core/handler.ts
 * <module-headers:end>
 */
import { b64urlDecode, b64urlEncode, sha256, toHex, utf8, verifyVapid, type Urgency } from "@yaran/protocol";
import type { RelayDeps } from "./deps.ts";
import { openEndpoint } from "./endpoint_codec.ts";
import { fail, readCapped } from "./http.ts";
import { verdictResponse, type UpstreamVerdict } from "./upstream.ts";

export const RELAY_MAX_BODY = 2900;
const URGENCIES = new Set<Urgency>(["very-low", "low", "normal", "high"]);
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;

export async function receive(deps: RelayDeps, segment: string, req: Request, requestId: string): Promise<Response> {
  const opened = await openEndpoint(deps.keys, segment);
  if (!opened) return fail("relay_endpoint_invalid", "This relay endpoint is not valid; register the device again.", requestId);
  const { kid, claims } = opened;
  const served = claims.p === "apns" ? deps.config.apns.topics.includes(claims.b) && deps.config.apns.environments.includes(claims.e) : deps.config.fcm?.appIds.includes(claims.b);
  if (!served) return fail("relay_endpoint_invalid", "This relay no longer serves this endpoint's app; register the device again.", requestId);

  const ttlText = req.headers.get("TTL");
  const urgency = (req.headers.get("Urgency") ?? "normal") as Urgency;
  const topic = req.headers.get("Topic");
  if (req.headers.get("Content-Encoding")?.toLowerCase() !== "aes128gcm" || !ttlText || !/^\d{1,8}$/.test(ttlText) || !URGENCIES.has(urgency) || (topic !== null && !TOPIC.test(topic))) {
    return fail("bad_request", "A relayed push needs Content-Encoding aes128gcm, a TTL, and valid Urgency and Topic headers.", requestId);
  }
  const body = await readCapped(req, RELAY_MAX_BODY);
  if (body === "too_large") return fail("payload_too_large", `A relayed push body may be at most ${RELAY_MAX_BODY} bytes.`, requestId);
  if (body.length === 0) return fail("bad_request", "A relayed push needs a body.", requestId);

  const boundKey = b64urlDecode(claims.k)!;
  const key8 = toHex(await sha256(boundKey)).slice(0, 8);
  const env = claims.p === "apns" ? claims.e : "fcm";
  const vapid = await verifyVapid(req.headers.get("Authorization"), { boundKey, audience: deps.config.publicOrigin, now: deps.now() });
  if (!vapid.ok) {
    deps.log("warn", "relay.refused", { outcome: vapid.code, kid, key8, env });
    return fail(vapid.code, vapid.code === "relay_vapid_mismatch" ? "The VAPID key is not the one this endpoint was minted for." : "The VAPID authorization is missing, expired or invalid.", requestId);
  }

  const keyHash = toHex(await sha256(boundKey));
  const deviceHash = toHex(await sha256(utf8.encode(claims.t)));
  if (!(await deps.limiters.key.allow(keyHash)) || !(await deps.limiters.device.allow(deviceHash))) {
    deps.log("warn", "relay.refused", { outcome: "rate_limited", kid, key8, env });
    return fail("rate_limited", "Too many pushes for this organization or device; retry after a minute.", requestId);
  }

  const input = { urgency, topic, ttl: Number(ttlText), registrationId: claims.r, body: b64urlEncode(body), appId: claims.b, now: deps.now() };
  let verdict: UpstreamVerdict;
  if (claims.p === "apns") verdict = await deps.apns.send({ token: claims.t, environment: claims.e }, input);
  else if (deps.fcm) verdict = await deps.fcm.send(claims.t, input);
  else return fail("relay_endpoint_invalid", "This relay no longer offers the fcm channel; register the device again.", requestId);

  const reason = "reason" in verdict ? verdict.reason : undefined;
  const level = verdict.kind === "misconfigured" ? "error" : verdict.kind === "delivered" ? "info" : "warn";
  deps.log(level, "relay.delivery", { outcome: verdict.kind, upstream_status: verdict.status, reason, kid, key8, env, urgency });
  return verdictResponse(verdict, requestId);
}
