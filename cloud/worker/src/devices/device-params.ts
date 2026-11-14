/**
 * Device registration validators (W12, W31): the device and push keys, the label and the
 * mute list, with the push endpoint judged by 08's endpoint policy
 * (`push/endpoint_policy.ts`: the SSRF rules, the per-channel shapes and the relay rules,
 * a trust boundary because the Worker later `fetch`es the endpoint, T57). The 02 schema
 * runs first; these checks add what a schema cannot say.
 *
 * <module-headers:begin>
 * Uses:
 * src/devices/device-params.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/http/responses.ts
 * └── src/push/endpoint_policy.ts
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
import { b64urlDecode, decodeP256Point, importP256Public, validate, type DevicePatch, type DeviceRegistration, type Settings } from "@yaran/protocol";
import { HttpError } from "../http/responses.ts";
import { checkPushEndpoint } from "../push/endpoint_policy.ts";

// C0, DEL, C1, and the bidi controls (LRM/RLM, embeddings/overrides, isolates, ALM).
// Control and bidi characters are exactly what this rejects.
// eslint-disable-next-line no-control-regex
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;

function failed(path: string, message: string): never {
  throw new HttpError("validation_failed", `Invalid ${path.slice(1)}: ${message}.`, { details: { errors: [{ path, message }] } });
}

/** Where the endpoint must not point: the control plane and its zone's machine hostnames. */
export interface EndpointScope {
  controlPlaneHost: string;
  zoneName: string;
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
  const p256dh = checkPoint("/push/keys/p256dh", p.keys.p256dh);
  try {
    await importP256Public(p256dh, "ECDH");
  } catch {
    failed("/push/keys/p256dh", "does not import as an ECDH P-256 key");
  }
  if (p.keys.auth.length !== 22 || b64urlDecode(p.keys.auth)?.length !== 16) failed("/push/keys/auth", "must be 16 bytes of base64url");
  // 08's endpoint policy: the SSRF rules, the per-channel endpoint shapes and the relay rules.
  const verdict = await checkPushEndpoint(p, { settings: push, zoneName: scope.zoneName || null, controlPlaneHost: scope.controlPlaneHost || null });
  if (!verdict.ok) throw new HttpError(verdict.code, verdict.message, "details" in verdict ? { details: verdict.details } : {});
  return { reg, deviceKey, push: { channel: p.channel, endpoint: p.endpoint, endpointHost: verdict.host, p256dh, auth: p.keys.auth, distributor: p.distributor ?? null } };
}

export function checkPatch(value: unknown): DevicePatch {
  schema("DevicePatch", value);
  const patch = value as DevicePatch;
  if (patch.label !== undefined) checkLabel(patch.label);
  return patch;
}
