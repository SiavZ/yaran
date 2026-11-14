/**
 * The one answer to "may this Worker push to this URL with these keys", called by Phase 06
 * at device registration (W12) before anything is stored.
 *
 * The endpoint is a URL the queue consumer will later fetch, so this is the SSRF and abuse
 * gate (T57): https only, no userinfo, port 443, at most 2048 bytes, a public DNS name (no
 * IP literal, single label, localhost, `.internal`/`.local`/`.arpa`, `workers.dev`, the
 * control-plane host or anything under the org's own zone), and a URL shape coherent with
 * the channel. Keys must be a P-256 point that imports for ECDH and a 16-byte auth secret.
 *
 * - Pure apart from one WebCrypto key import.
 * - Refusals carry 02's codes: 400 push_endpoint_invalid, 409 push_relay_disallowed with
 *   details.reason disabled | not_allowlisted.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/endpoint_policy.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/push/settings.ts
 * └── src/push/types.ts
 * External: none
 *
 * Used by:
 * src/push/endpoint_policy.ts
 * ├── src/devices/device-params.ts
 * └── test/push/endpoint_policy.test.ts
 * <module-headers:end>
 */
import { b64urlDecode, decodeP256Point, importP256Public, utf8, type PushWebpush } from "@yaran/protocol";
import type { PushSettings } from "./types.ts";
import { assertNever, relayVerdict } from "./settings.ts";

export const ENDPOINT_MAX_BYTES = 2048;
const RELAY_PATH = /^\/w\/v1\.[A-Za-z0-9_-]{1,16}\.[A-Za-z0-9_-]{16,1024}$/;
const FCM_HOST = "fcm.googleapis.com";
const BLOCKED_SUFFIXES = [".internal", ".local", ".arpa", ".localhost", ".workers.dev"];

export interface EndpointContext {
  settings: PushSettings;
  /** The org's zone (machine hostnames live under it); null before setup records it. */
  zoneName: string | null;
  controlPlaneHost: string | null;
}

export type EndpointVerdict =
  | { ok: true; host: string; origin: string }
  | { ok: false; code: "push_endpoint_invalid"; message: string }
  | { ok: false; code: "push_relay_disallowed"; message: string; details: { reason: "disabled" | "not_allowlisted" } };

const invalid = (message: string): EndpointVerdict => ({ ok: false, code: "push_endpoint_invalid", message });

function hostRefusal(host: string, ctx: EndpointContext): string | null {
  if (host.startsWith("[") || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) return "The push endpoint host is an IP address; a DNS name is required.";
  if (!host.includes(".") || host === "localhost") return "The push endpoint host is not a public DNS name.";
  // A trailing dot names the same host and would slip past the suffix and zone rules.
  if (host.endsWith(".")) return "The push endpoint host must not end with a dot.";
  if (host === "workers.dev" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return "The push endpoint host is not a public push service.";
  const zone = ctx.zoneName?.toLowerCase();
  if (host === ctx.controlPlaneHost?.toLowerCase() || (zone && (host === zone || host.endsWith(`.${zone}`)))) {
    return "The push endpoint points into this organization's own zone.";
  }
  return null;
}

function channelRefusal(sub: PushWebpush, url: URL): string | null {
  switch (sub.channel) {
    case "fcm_embedded":
      return url.hostname === FCM_HOST && (url.pathname.startsWith("/fcm/send/") || url.pathname.startsWith("/wp/"))
        ? null
        : "An embedded FCM endpoint must be fcm.googleapis.com under /fcm/send/ or /wp/.";
    case "apns_relay":
    case "fcm_relay":
      return url.hostname !== FCM_HOST && RELAY_PATH.test(url.pathname) && !url.search && !url.hash
        ? null
        : "A relay endpoint must have the shape https://<relay>/w/v1.<kid>.<opaque>.";
    case "unifiedpush":
      return null;
    default:
      return assertNever(sub.channel);
  }
}

/** Checks a registration's push subscription; `ok` carries the host and origin to store. */
export async function checkPushEndpoint(sub: PushWebpush, ctx: EndpointContext): Promise<EndpointVerdict> {
  if (utf8.encode(sub.endpoint).length > ENDPOINT_MAX_BYTES) return invalid(`The push endpoint is longer than ${ENDPOINT_MAX_BYTES} bytes.`);
  let url: URL;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return invalid("The push endpoint is not a URL.");
  }
  if (url.protocol !== "https:") return invalid("The push endpoint must use https.");
  if (url.username || url.password) return invalid("The push endpoint must not carry credentials.");
  if (url.port !== "" && url.port !== "443") return invalid("The push endpoint must use port 443.");
  const host = url.hostname.toLowerCase();
  const refusal = hostRefusal(host, ctx) ?? channelRefusal(sub, url);
  if (refusal) return invalid(refusal);
  const p256dh = decodeP256Point(sub.keys.p256dh);
  if (!p256dh) return invalid("keys.p256dh must be a 65-byte uncompressed P-256 point on the curve.");
  try {
    await importP256Public(p256dh, "ECDH");
  } catch {
    return invalid("keys.p256dh does not import as a P-256 ECDH key.");
  }
  if (b64urlDecode(sub.keys.auth)?.length !== 16) return invalid("keys.auth must be base64url of exactly 16 bytes.");
  const origin = `https://${host}`;
  const verdict = relayVerdict(ctx.settings, sub.channel, origin);
  switch (verdict) {
    case "ok":
      return { ok: true, host, origin };
    case "disabled":
      return { ok: false, code: "push_relay_disallowed", message: "This organization does not allow relayed push.", details: { reason: verdict } };
    case "not_allowlisted":
      return { ok: false, code: "push_relay_disallowed", message: "This relay is not on the organization's allowed relay list.", details: { reason: verdict } };
    default:
      return assertNever(verdict);
  }
}
