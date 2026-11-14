/**
 * Web Push message encryption (RFC 8291 over RFC 8188 `aes128gcm`, one record).
 *
 * The org Worker encrypts every push with a fresh ephemeral P-256 key and a random salt
 * (RFC 8291 §3.1); tests and tooling decrypt with the device's keys. The header is
 * salt 16 ‖ rs 4 ‖ idlen 1 ‖ keyid 65 (86 bytes), the record is plaintext ‖ 0x02 (last-record
 * delimiter, no padding) sealed with AES-128-GCM, so a 4096-byte record holds 3993 bytes.
 *
 * - WebCrypto only (ECDH, HKDF, AES-GCM): runs unchanged in Workers, Node and browsers.
 * - decrypt refuses anything but one well-formed record: bad header, wrong tag, a delimiter
 *   other than 0x02, or trailing records.
 *
 * <module-headers:begin>
 * Uses:
 * src/webpush/ece.ts
 * ├── src/b64url.ts
 * └── src/jwe/ec.ts
 * External: none
 *
 * Used by:
 * src/webpush/ece.ts
 * ├── src/index.ts
 * └── test/webpush.test.ts
 * <module-headers:end>
 */
import { b64urlEncode, concatBytes, utf8 } from "../b64url.ts";
import { importP256Public, pointToJwk } from "../jwe/ec.ts";

export const ECE_RECORD_SIZE = 4096;
const HEADER_BYTES = 16 + 4 + 1 + 65;
const TAG_BYTES = 16;
/** The most plaintext one record of ECE_RECORD_SIZE bytes holds (RFC 8291 §4). */
export const ECE_MAX_PLAINTEXT = ECE_RECORD_SIZE - HEADER_BYTES - TAG_BYTES - 1;

/** A P-256 ECDH key pair with its raw 65-byte public point. */
export interface EcdhKeyPair {
  privateKey: CryptoKey;
  publicRaw: Uint8Array;
}

/** The keys RFC 8291 §3.3-3.4 derives, exported for the Appendix A test. */
export interface WebPushKeys {
  ikm: Uint8Array;
  cek: Uint8Array;
  nonce: Uint8Array;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/** RFC 8291 §3.4 IKM, then RFC 8188 §2.2-2.3 content-encryption key and nonce. */
export async function webPushKeys(
  ecdhSecret: Uint8Array,
  authSecret: Uint8Array,
  uaPublic: Uint8Array,
  asPublic: Uint8Array,
  salt: Uint8Array,
): Promise<WebPushKeys> {
  const keyInfo = concatBytes(utf8.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8.encode("Content-Encoding: nonce\0"), 12);
  return { ikm, cek, nonce };
}

async function ecdh(privateKey: CryptoKey, peerRaw: Uint8Array): Promise<Uint8Array> {
  const peer = await importP256Public(peerRaw, "ECDH");
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer } as Parameters<SubtleCrypto["deriveBits"]>[0], privateKey, 256));
}

/** A fresh extractable-public P-256 ECDH key pair. */
export async function generateEcdhKeyPair(): Promise<EcdhKeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicRaw: new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer) };
}

/** Imports a P-256 private scalar (32 bytes) and its public point for ECDH (tests, tooling). */
export async function importEcdhPrivate(d: Uint8Array, publicRaw: Uint8Array): Promise<CryptoKey> {
  const jwk = { ...pointToJwk(publicRaw), d: b64urlEncode(d) };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

export interface EncryptOptions {
  /** Record size written in the header; the body must fit one record. Default 4096. */
  rs?: number;
  /** Fixed salt for test vectors only; production always draws 16 random bytes. */
  salt?: Uint8Array;
  /** Fixed sender key for test vectors only; production always generates a fresh one. */
  asKeyPair?: EcdhKeyPair;
}

/**
 * Encrypts one Web Push message to a subscription's `p256dh` (65 bytes) and `auth` (16 bytes).
 * Throws when the plaintext does not fit a single record.
 */
export async function encryptWebPush(
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  opts: EncryptOptions = {},
): Promise<Uint8Array> {
  const rs = opts.rs ?? ECE_RECORD_SIZE;
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("p256dh must be 65 bytes and auth 16 bytes");
  if (HEADER_BYTES + plaintext.length + 1 + TAG_BYTES > rs) {
    throw new Error(`web push plaintext of ${plaintext.length} bytes does not fit one ${rs}-byte record`);
  }
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const as = opts.asKeyPair ?? (await generateEcdhKeyPair());
  const keys = await webPushKeys(await ecdh(as.privateKey, uaPublic), authSecret, uaPublic, as.publicRaw, salt);
  const cek = await crypto.subtle.importKey("raw", keys.cek as BufferSource, "AES-GCM", false, ["encrypt"]);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: keys.nonce as BufferSource },
    cek,
    concatBytes(plaintext, Uint8Array.of(2)) as BufferSource,
  );
  const header = new Uint8Array(HEADER_BYTES);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = 65;
  header.set(as.publicRaw, 21);
  return concatBytes(header, new Uint8Array(sealed));
}

/** Decrypts one aes128gcm Web Push body with the subscription's private key; throws on any defect. */
export async function decryptWebPush(
  body: Uint8Array,
  uaPrivate: CryptoKey,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
): Promise<Uint8Array> {
  if (body.length < HEADER_BYTES + TAG_BYTES + 1) throw new Error("web push body is shorter than one header and tag");
  const salt = body.subarray(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  if (body[20] !== 65) throw new Error("web push keyid must be a 65-byte P-256 point");
  if (body.length > rs) throw new Error("web push body holds more than one record");
  const asPublic = body.subarray(21, HEADER_BYTES);
  const keys = await webPushKeys(await ecdh(uaPrivate, asPublic), authSecret, uaPublic, asPublic, salt);
  const cek = await crypto.subtle.importKey("raw", keys.cek as BufferSource, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: keys.nonce as BufferSource }, cek, body.subarray(HEADER_BYTES) as BufferSource),
  );
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (end < 0 || padded[end] !== 2) throw new Error("web push record does not end with the last-record delimiter 0x02");
  return padded.subarray(0, end);
}
