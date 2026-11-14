/**
 * Device registration validators (W12, W31): the push endpoint's SSRF rules, the relay
 * rules, the device and push keys, the label and the mute list. Pure: no D1, no network.
 *
 * The endpoint is a URL the Worker later `fetch`es (08), so every rule here is a trust
 * boundary (T57). The 02 schema runs first; these checks add what a schema cannot say.
 *
 * - Hosts are judged after the WHATWG URL parser has normalized them, so decimal, hex
 *   and octal IPv4 spellings all arrive as a dotted quad and are refused as IP literals.
 * - IDN hosts are accepted in their punycoded form: self-hosted UnifiedPush distributors
 *   may live on one, and the `xn--` label is an ordinary DNS name to the suffix rules.
 * - A trailing-dot or single-label host is refused: it would slip past the suffix rules.
 *
 * <module-headers:begin>
 * Uses:
 * src/devices/device-params.ts
 * ├── @yaran/protocol:src/index.ts
 * └── src/http/responses.ts
 * External: none
 *
 * Used by:
 * src/devices/device-params.ts
 * ├── src/devices/devices-repo.ts
 * ├── src/me/devices-route.ts
 * ├── test/devices/device-params.test.ts
 * └── test/devices/devices-repo.test.ts
 * <module-headers:end>
 */
import { b64urlDecode, decodeP256Point, HOSTNAME_RE, importP256Public, validate, type DevicePatch, type DeviceRegistration, type Settings } from "@yaran/protocol";
import { HttpError } from "../http/responses.ts";

export const ENDPOINT_MAX_CHARS = 2048;
const BLOCKED_SUFFIXES = ["localhost", "internal", "local", "arpa", "workers.dev"];
// C0, DEL, C1, and the bidi controls (LRM/RLM, embeddings/overrides, isolates, ALM).
// Control and bidi characters are exactly what this rejects.
// eslint-disable-next-line no-control-regex
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;

function invalidEndpoint(why: string): never {
  throw new HttpError("push_endpoint_invalid", `The push endpoint is not allowed: ${why}.`);
}

function failed(path: string, message: string): never {
  throw new HttpError("validation_failed", `Invalid ${path.slice(1)}: ${message}.`, { details: { errors: [{ path, message }] } });
}

const underSuffix = (host: string, suffix: string) => host === suffix || host.endsWith(`.${suffix}`);

/** Where the endpoint must not point: the control plane and its zone's machine hostnames. */
export interface EndpointScope {
  controlPlaneHost: string;
  zoneName: string;
}

/** Validates a push endpoint; returns its host for `Device.push.endpoint_host`. */
export function checkEndpoint(endpoint: string, scope: EndpointScope): string {
  if (endpoint.length > ENDPOINT_MAX_CHARS) invalidEndpoint("longer than 2048 characters");
  if (!endpoint.startsWith("https://")) invalidEndpoint("it must start with https://");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    invalidEndpoint("it is not a URL");
  }
  if (url.username || url.password) invalidEndpoint("it carries credentials");
  if (url.port !== "") invalidEndpoint("only port 443 is allowed");
  const host = url.hostname;
  if (host.startsWith("[") || /^[0-9.]+$/.test(host)) invalidEndpoint("IP addresses are not allowed");
  if (!HOSTNAME_RE.test(host) || !host.includes(".")) invalidEndpoint("the host is not a public DNS name");
  if (BLOCKED_SUFFIXES.some((s) => underSuffix(host, s))) invalidEndpoint("the host is a local or internal name");
  if (host === scope.controlPlaneHost.toLowerCase() || underSuffix(host, scope.zoneName.toLowerCase())) {
    invalidEndpoint("it points at this org's own hosts");
  }
  return host;
}

/** Relay channels need `push.relay_allowed`, and an allowlisted origin when a list is set. */
export function checkRelay(channel: string, endpoint: string, push: Settings["push"]): void {
  if (channel !== "apns_relay" && channel !== "fcm_relay") return;
  if (!push.relay_allowed) {
    throw new HttpError("push_relay_disallowed", "This org does not allow push relays, so this phone cannot receive notifications here.", { details: { reason: "disabled" } });
  }
  if (push.allowed_relays.length > 0 && !push.allowed_relays.includes(new URL(endpoint).origin)) {
    throw new HttpError("push_relay_disallowed", "This org only allows its listed push relays; ask an admin to add this one.", { details: { reason: "not_allowlisted" } });
  }
}

/** The 65 raw bytes of an on-curve P-256 point, or a `validation_failed` naming the field. */
export function checkPoint(path: string, point: string): Uint8Array {
  const raw = decodeP256Point(point);
  if (!raw) failed(path, "not an uncompressed P-256 point on the curve");
  return raw;
}

export function checkLabel(label: string): void {
  if (CONTROL_OR_BIDI.test(label)) failed("/label", "control and bidi characters are not allowed");
}

function schema(type: "DeviceRegistration" | "DevicePatch", value: unknown): void {
  const r = validate(type, value);
  if (!r.valid) {
    throw new HttpError("validation_failed", `The request does not match ${type}.`, { details: { errors: r.errors.map((e) => ({ path: e.path, message: e.message })) } });
  }
}

/** A validated registration with its decoded keys. */
export interface CheckedRegistration {
  reg: DeviceRegistration;
  deviceKey: Uint8Array;
  push: { channel: string; endpoint: string; endpointHost: string; p256dh: Uint8Array; auth: string; distributor: string | null } | null;
}

export async function checkRegistration(value: unknown, scope: EndpointScope, push: Settings["push"]): Promise<CheckedRegistration> {
  schema("DeviceRegistration", value);
  const reg = value as DeviceRegistration;
  const deviceKey = checkPoint("/device_key", reg.device_key);
  checkLabel(reg.label);
  if (reg.push.kind === "none") return { reg, deviceKey, push: null };
  const p = reg.push;
  const endpointHost = checkEndpoint(p.endpoint, scope);
  checkRelay(p.channel, p.endpoint, push);
  const p256dh = checkPoint("/push/keys/p256dh", p.keys.p256dh);
  try {
    await importP256Public(p256dh, "ECDH");
  } catch {
    failed("/push/keys/p256dh", "does not import as an ECDH P-256 key");
  }
  if (p.keys.auth.length !== 22 || b64urlDecode(p.keys.auth)?.length !== 16) failed("/push/keys/auth", "must be 16 bytes of base64url");
  return { reg, deviceKey, push: { channel: p.channel, endpoint: p.endpoint, endpointHost, p256dh, auth: p.keys.auth, distributor: p.distributor ?? null } };
}

export function checkPatch(value: unknown): DevicePatch {
  schema("DevicePatch", value);
  const patch = value as DevicePatch;
  if (patch.label !== undefined) checkLabel(patch.label);
  return patch;
}
