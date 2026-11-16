/**
 * Device registration fixtures for the device suites: a schema-valid
 * `DeviceRegistration` with a real P-256 device key from 02's fingerprint fixture and a
 * freshly generated push key.
 *
 * <module-headers:begin>
 * Uses:
 * test/devices/device-fixtures.ts
 * ├── @yaran/protocol:src/index.ts
 * └── cloud/protocol/fixtures/sig/device-fingerprint.json
 * External: none
 *
 * Used by:
 * test/devices/device-fixtures.ts
 * ├── test/devices/device-params.test.ts
 * ├── test/devices/devices-repo.test.ts
 * ├── test/devices/devices-route.test.ts
 * └── test/pairing/audit-coverage.test.ts
 * <module-headers:end>
 */
import { b64urlEncode, type DeviceRegistration, type PushWebpush } from "@yaran/protocol";
import fp from "@yaran/protocol/fixtures/sig/device-fingerprint.json" with { type: "json" };

export const DEVICE_KEYS = fp.cases;

export async function p256Point(): Promise<string> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return b64urlEncode(new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer));
}

export async function registration(o: Partial<DeviceRegistration> = {}): Promise<DeviceRegistration & { push: PushWebpush }> {
  return {
    install_id: crypto.randomUUID(),
    device_key: DEVICE_KEYS[0]!.dk,
    platform: "android",
    flavor: "foss",
    form_factor: "phone",
    app_version: "1.2.3",
    label: "Ada's Pixel",
    push: {
      kind: "webpush",
      channel: "unifiedpush",
      distributor: "io.heckel.ntfy",
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: await p256Point(), auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))) },
    },
    mute_all: false,
    muted_until: null,
    muted_machine_ids: [],
    ...o,
  } as DeviceRegistration & { push: PushWebpush };
}
