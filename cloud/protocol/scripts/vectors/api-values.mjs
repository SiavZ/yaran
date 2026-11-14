/**
 * Shared values and mutation helpers for the API schema fixtures.
 *
 * Holds the fixed, deterministic building blocks every API case module uses: real P-256
 * points and a real Ed25519 public key derived from fixed labels, ids, timestamps and
 * example.com/example.org names (RFC 2606), plus `m()`, which derives a one-change
 * invalid value from a valid base.
 *
 * - Deterministic: no randomness and no clock.
 * - Keys are derived with node:crypto only (independent of src/).
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:crypto
 *
 * Used by:
 * scripts/vectors/api-values.mjs
 * ├── scripts/vectors/api-cases-admin.mjs
 * ├── scripts/vectors/api-cases-common.mjs
 * ├── scripts/vectors/api-cases-handoff.mjs
 * └── scripts/vectors/api-cases-machine.mjs
 * <module-headers:end>
 */
import { createECDH, createHash, createPrivateKey, createPublicKey } from "node:crypto";

const sha = (label) => createHash("sha256").update(label).digest();

/** A real uncompressed P-256 point (base64url) from a fixed label. */
export function point(label) {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(sha(`yaran-fixture-p256:${label}`));
  return ecdh.getPublicKey().toString("base64url");
}

/** A real Ed25519 public key (base64url) from a fixed seed label. */
export function ed25519(label) {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), sha(`yaran-fixture-ed25519:${label}`)]);
  return createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "jwk" }).x;
}

/** 64 bytes with 0 < r, s < n (first byte of each half forced to 0x01). */
export function ecdsaSig(label) {
  const r = sha(`r:${label}`);
  const s = sha(`s:${label}`);
  r[0] = 1;
  s[0] = 1;
  return Buffer.concat([r, s]).toString("base64url");
}

export const DEL = Symbol("delete");

/** A deep copy of base with each dotted path set (or removed with DEL). */
export function m(base, changes) {
  const out = structuredClone(base);
  for (const [path, value] of Object.entries(changes)) {
    const keys = path.split(".");
    let node = out;
    for (const k of keys.slice(0, -1)) node = node[k];
    const last = keys.at(-1);
    if (value === DEL) delete node[last];
    else node[last] = value;
  }
  return out;
}

/** One type's cases. */
export const T = (type, file, valid, invalid) => ({ type, file, valid, invalid });

/** Enum type: every value valid, one stranger invalid. */
export const E = (type, file, values) =>
  T(type, file, values.map((v) => [v, v]), [["not in the enum", "enum", "not_a_value"], ["not a string", "enum", 1]]);

export const U1 = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b";
export const U2 = "9b8a7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d";
export const U3 = "c0ffee00-1234-4abc-bdef-0123456789ab";
export const TS = "2026-11-14T12:00:00Z";
export const TS2 = "2026-11-15T08:30:00Z";
export const HOST = "laptop-ada.example.com";
export const CP = "https://cp.example.com";
export const TEAM = "ada-team.example.com";
export const EMAIL = "ada@example.org";
export const FP = "K7QF-3MZD-W2PA-HX5R-LC4N-TB6E";
export const STATE = "s3cr3tStateValue_abcdefGHIJ";
export const CSRF = "csrfTokenValue_0123456789ab";
export const AUD = "a".repeat(32) + "0123456789abcdef0123456789abcdef";
export const B43 = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
export const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk.~";
export const PK = point("handoff-pk");
export const DK = point("device-key");
export const VAPID = point("vapid");
export const MACHINE_PUB = ed25519("machine");
export const DSIG = ecdsaSig("dsig");
export const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6ImFkYUBleGFtcGxlLm9yZyJ9.c2lnbmF0dXJl";
