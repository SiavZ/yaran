/**
 * Generates the Cloudflare Access JWT fixtures under `access-jwt/` (Phase 11 §4): a
 * synthetic team's JWKS before and after a key rotation, and named tokens covering every
 * check yaran's verifier makes (and Phase 04's Worker reuses).
 *
 * - The RSA-2048 keys are random, so they are generated once and committed in
 *   `access-jwt/keys.json` (SYNTHETIC test keys, never used anywhere real); a rerun keeps
 *   them through `ctx.previous`. RS256 (PKCS#1 v1.5) is deterministic, so every token is
 *   reproducible byte for byte from those keys and the fixed claims below.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:crypto
 *
 * Used by:
 * scripts/vectors/access-jwt.mjs
 * └── scripts/gen-vectors.mjs
 * <module-headers:end>
 */
import { createHmac, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";

const TEAM = "fixture-team.cloudflareaccess.com";
const AUD = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";
const OWNER = "owner@example.com";
const SUB = "7335d417-61da-459d-899c-0a01c76a2f94";
const NOW = 1731571200;
const SKEW = 30;
const KIDS = ["fixture-current", "fixture-previous", "fixture-rotated", "fixture-unpublished"];

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const json64 = (v) => b64u(JSON.stringify(v));

function keys(previous) {
  if (previous && KIDS.every((kid) => previous.keys?.some((k) => k.kid === kid))) return previous;
  const generated = KIDS.map((kid) => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    return { ...privateKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  });
  return { description: "SYNTHETIC RSA-2048 test keys for the access-jwt fixtures. Never used anywhere real.", keys: generated };
}

const pub = ({ kty, kid, alg, use, n, e }) => ({ kty, kid, alg, use, n, e });

function rs256(jwk, header, claims) {
  const input = `${json64(header)}.${json64(claims)}`;
  const sig = sign("sha256", Buffer.from(input), createPrivateKey({ key: jwk, format: "jwk" }));
  return `${input}.${b64u(sig)}`;
}

const base = {
  aud: [AUD],
  email: OWNER,
  exp: NOW + 3600,
  iat: NOW - 60,
  nbf: NOW - 60,
  iss: `https://${TEAM}`,
  type: "app",
  identity_nonce: "fixture-nonce",
  sub: SUB,
  country: "NL",
};

export async function generate(ctx) {
  const k = keys(ctx.previous("access-jwt/keys.json"));
  const byKid = Object.fromEntries(k.keys.map((key) => [key.kid, key]));
  const signed = (kid, claims = base, header = {}) =>
    rs256(byKid[kid], { alg: "RS256", kid, typ: "JWT", ...header }, claims);
  const valid = signed("fixture-current");
  const [vh, vp, vs] = valid.split(".");
  const flipped = Buffer.from(vs, "base64url");
  flipped[flipped.length - 1] ^= 0x01;
  const hsInput = `${json64({ alg: "HS256", kid: "fixture-current", typ: "JWT" })}.${vp}`;
  const { email: _e, ...noEmail } = base;
  const cases = [
    ["valid", valid, "ok"],
    ["aud as string", signed("fixture-current", { ...base, aud: AUD }), "ok"],
    ["uppercase email", signed("fixture-current", { ...base, email: "Owner@Example.COM" }), "ok"],
    ["previous key", signed("fixture-previous"), "ok"],
    ["expired", signed("fixture-current", { ...base, exp: NOW - SKEW }), "access-expired"],
    ["nbf in the future", signed("fixture-current", { ...base, nbf: NOW + SKEW + 1 }), "access-not-yet-valid"],
    ["wrong aud", signed("fixture-current", { ...base, aud: ["another-application-aud"] }), "access-wrong-audience"],
    ["wrong iss", signed("fixture-current", { ...base, iss: "https://other-team.cloudflareaccess.com" }), "access-wrong-issuer"],
    ["not an app token", signed("fixture-current", { ...base, type: "org" }), "access-not-app-token"],
    ["service token", signed("fixture-current", { ...noEmail, sub: "", common_name: "a1b2c3.access" }), "access-service-token"],
    ["other email", signed("fixture-current", { ...base, email: "someone-else@example.com" }), "access-not-owner"],
    ["alg none", `${json64({ alg: "none", kid: "fixture-current" })}.${vp}.`, "access-bad-algorithm"],
    ["alg HS256", `${hsInput}.${b64u(createHmac("sha256", "fixture-hs256-secret").update(hsInput).digest())}`, "access-bad-algorithm"],
    ["missing kid", rs256(byKid["fixture-current"], { alg: "RS256", typ: "JWT" }, base), "access-malformed"],
    ["unknown kid", signed("fixture-unpublished"), "access-unknown-kid"],
    ["signature flipped", `${vh}.${vp}.${b64u(flipped)}`, "access-bad-signature"],
    ["oversized", signed("fixture-current", { ...base, pad: "x".repeat(8192) }), "access-malformed"],
    ["two segments", `${vh}.${vp}`, "access-malformed"],
  ];
  return {
    "access-jwt/keys.json": k,
    "access-jwt/jwks.json": { keys: [pub(byKid["fixture-current"]), pub(byKid["fixture-previous"])] },
    "access-jwt/jwks-rotated.json": { keys: [pub(byKid["fixture-rotated"]), pub(byKid["fixture-current"])] },
    "access-jwt/tokens.json": {
      description: "Cloudflare Access application JWTs for one synthetic team, verified against jwks.json at `now` with `skew_seconds`. expect is ok or the Yaran-Refusal code (02 §13) of the first failing check.",
      team_domain: TEAM,
      aud: AUD,
      owner_email: OWNER,
      now: NOW,
      skew_seconds: SKEW,
      cases: cases.map(([name, token, expect]) => ({ name, token, expect })),
    },
  };
}
