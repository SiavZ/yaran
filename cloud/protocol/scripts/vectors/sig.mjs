/**
 * Generates `fixtures/sig/`: Ed25519 machine request-signing vectors (Design §7), the
 * verifier's negative sequences, and the machine key fingerprint vectors (§7.1).
 *
 * Signatures come from node:crypto Ed25519 (RFC 8032, deterministic), so the Rust signer
 * must reproduce them byte for byte. The negatives are request sequences fed to one
 * verifier with one nonce store, each step naming the expected outcome.
 *
 * <module-headers:begin>
 * Uses:
 * scripts/vectors/sig.mjs
 * └── scripts/vectors/keys.mjs
 * External: node:crypto
 *
 * Used by:
 * scripts/vectors/sig.mjs
 * ├── scripts/gen-vectors.mjs
 * └── scripts/vectors/consent.mjs
 * <module-headers:end>
 */
import { sign } from "node:crypto";
import { b64u, ed25519FromLabel, hex, sha256 } from "./keys.mjs";

const MACHINE_ID = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b";
const NOW = 1731571200;
const HOST = "cp.example.com";
const PAIR_CODE = b64u(sha256("yaran-fixture/pair-code")).slice(0, 43);

function canonical(r) {
  return [
    "yaran-machine-sig-v1",
    r.method.toUpperCase(),
    r.path,
    r.host.toLowerCase().replace(/:[0-9]*$/, ""),
    r.protocol,
    r.machine_id ?? "-",
    r.timestamp,
    r.nonce,
    hex(sha256(Buffer.from(r.body, "utf8"))),
  ].join("\n");
}

function signed(key, r) {
  const text = canonical(r);
  const signature = b64u(sign(null, Buffer.from(text, "utf8"), key.privateKey));
  const headers = { "Yaran-Protocol": r.protocol, "Yaran-Timestamp": r.timestamp, "Yaran-Nonce": r.nonce, "Yaran-Signature": signature };
  if (r.machine_id) headers["Yaran-Machine-Id"] = r.machine_id;
  return { ...r, canonical: text, body_sha256_hex: hex(sha256(Buffer.from(r.body, "utf8"))), signature, headers };
}

const nonce = (label) => b64u(sha256(`yaran-fixture/nonce/${label}`).subarray(0, 16));

function requests(key) {
  const claimBody = JSON.stringify({ code: PAIR_CODE, code_verifier: b64u(sha256("yaran-fixture/verifier")), yaran_version: "0.42.0", origin_port: 3890 });
  const eventsBody = JSON.stringify({
    events: [{ id: "0b8e4c1d-2f3a-4b5c-9d6e-7f8091a2b3c4", kind: "attention_raised", ts: "2024-11-14T08:00:00Z", agent_id: "1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f", state: "needs_attention", project: "yaran", label: "fix the tests" }],
  });
  return {
    claim: signed(key, { method: "POST", path: "/v1/machine/claim", host: HOST, protocol: "1", machine_id: null, timestamp: String(NOW), nonce: nonce("claim"), body: claimBody }),
    events: signed(key, { method: "post", path: "/v1/machine/events", host: "CP.Example.com:443", protocol: "1", machine_id: MACHINE_ID, timestamp: String(NOW + 5), nonce: nonce("events"), body: eventsBody }),
    config: signed(key, { method: "GET", path: "/v1/machine/config", host: HOST, protocol: "1", machine_id: MACHINE_ID, timestamp: String(NOW + 10), nonce: nonce("config"), body: "" }),
  };
}

const received = (r, over = {}) => ({
  method: r.method,
  path: r.path,
  host: r.host,
  headers: { ...r.headers, ...(over.headers ?? {}) },
  body: over.body ?? r.body,
  ...(r.machine_id === null ? { claim_code: PAIR_CODE } : {}),
  now: over.now ?? Number(r.timestamp),
  ...Object.fromEntries(Object.entries(over).filter(([k]) => !["headers", "body", "now"].includes(k))),
});

function negatives(key, other, reqs) {
  const { events, config, claim } = reqs;
  const ok = { ok: true };
  const step = (r, expect, over) => ({ ...received(r, over), expect });
  const revoked = signed(other, { ...config, machine_id: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", nonce: nonce("revoked") });
  const unknown = signed(key, { ...config, machine_id: "00000000-0000-4000-8000-000000000000", nonce: nonce("unknown") });
  return {
    description: "Each case runs its requests in order against one fresh verifier and nonce store. expect is {ok:true} or {code}.",
    protocol: { min: 1, max: 1 },
    machines: [
      { machine_id: MACHINE_ID, public_key: b64u(key.pub), revoked: false },
      { machine_id: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", public_key: b64u(other.pub), revoked: true },
    ],
    pair_codes: [{ code: PAIR_CODE, public_key: b64u(key.pub) }],
    cases: [
      { name: "valid events then config", requests: [step(events, ok), step(config, ok)] },
      { name: "valid claim", requests: [step(claim, ok)] },
      { name: "replayed nonce", requests: [step(config, ok), step(config, { code: "nonce_replayed" }, { now: Number(config.timestamp) + 30 })] },
      { name: "wrong host", requests: [step(config, { code: "signature_invalid" }, { host: "cp2.example.com" })] },
      { name: "body tampered", requests: [step(events, { code: "signature_invalid" }, { body: events.body.replace("fix the tests", "fix the tests!") })] },
      { name: "timestamp skewed +301", requests: [step(config, { code: "signature_expired" }, { now: Number(config.timestamp) - 301 })] },
      { name: "timestamp skew 300 accepted", requests: [step(config, ok, { now: Number(config.timestamp) + 300 })] },
      { name: "query present", requests: [step(config, { code: "signature_invalid" }, { path: "/v1/machine/config?x=1" })] },
      { name: "bare machine path", requests: [step(config, { code: "signature_invalid" }, { path: "/v1/machine" })] },
      { name: "signature header missing", requests: [step(config, { code: "signature_missing" }, { headers: { "Yaran-Signature": null } })] },
      { name: "machine id on the claim route", requests: [step(claim, { code: "signature_missing" }, { headers: { "Yaran-Machine-Id": MACHINE_ID } })] },
      { name: "protocol out of range", requests: [step(config, { code: "protocol_unsupported" }, { headers: { "Yaran-Protocol": "2" } })] },
      { name: "unknown machine", requests: [step(unknown, { code: "machine_unknown" })] },
      { name: "unknown pair code", requests: [step(claim, { code: "pair_code_invalid" }, { claim_code: b64u(sha256("yaran-fixture/other-code")).slice(0, 43) })] },
      { name: "revoked machine with a valid signature", requests: [step(revoked, { code: "machine_revoked" })] },
      { name: "revoked machine with a bad signature hides revocation", requests: [step(revoked, { code: "signature_invalid" }, { host: "cp2.example.com" })] },
    ],
  };
}

function fingerprint(tag, raw) {
  const digest = sha256(Buffer.concat([Buffer.from(tag), raw]));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const b of digest.subarray(0, 15)) bits += b.toString(2).padStart(8, "0");
  const fp24 = bits.match(/.{5}/g).map((g) => alphabet[parseInt(g, 2)]).join("");
  return { digest_hex: hex(digest), fp24, fingerprint: fp24.match(/.{4}/g).join("-") };
}

export { fingerprint };

export async function generate() {
  const key = ed25519FromLabel("machine-key");
  const other = ed25519FromLabel("machine-key/other");
  const reqs = requests(key);
  return {
    "sig/machine-request.json": {
      description: "Ed25519 machine request signing (Design §7). Signatures are deterministic: a signer must reproduce them byte for byte.",
      seed_hex: hex(key.seed),
      pkcs8_v1_hex: hex(key.pkcs8V1),
      pkcs8_v2_hex: hex(key.pkcs8V2),
      public_key: b64u(key.pub),
      empty_body_sha256_hex: hex(sha256(Buffer.alloc(0))),
      requests: Object.entries(reqs).map(([name, r]) => ({ name, ...r })),
    },
    "sig/machine-request-negatives.json": negatives(key, other, reqs),
    "sig/fingerprint.json": {
      description: "MachineKeyFingerprint (Design §7.1): base32(SHA-256(tag || 32-byte key)[0..15]) in six dashed groups.",
      tag: "yaran-machine-key-v1\n",
      cases: ["machine-key", "machine-key/other", "fingerprint/a", "fingerprint/b"].map((label) => {
        const pub = ed25519FromLabel(label).pub;
        return { public_key: b64u(pub), public_key_hex: hex(pub), ...fingerprint("yaran-machine-key-v1\n", pub) };
      }),
    },
  };
}
