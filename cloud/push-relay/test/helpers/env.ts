/**
 * Test environment for the relay: generated APNs and FCM credentials, endpoint keys, a VAPID
 * signer from the shared fixtures, a mock APNs that answers both as an in-process transport
 * and as a cleartext node:http2 server, and a mock Google (OAuth token + FCM v1) fetch.
 *
 * <module-headers:begin>
 * Uses:
 * test/helpers/env.ts
 * ├── @yaran/protocol:src/index.ts
 * └── src/apns/transport.ts
 * External: node:fs, node:http2, node:net
 *
 * Used by:
 * test/helpers/env.ts
 * ├── test/fcm.test.ts
 * ├── test/helpers/runtimes.ts
 * └── test/relay.test.ts
 * <module-headers:end>
 */
import { readFileSync } from "node:fs";
import { createServer, type Http2Server, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import { b64urlEncode, importVapidPrivateJwk, signVapid, type VapidSigner } from "@yaran/protocol";
import type { ApnsTransport } from "../../src/apns/transport.ts";

export const NOW = 1731571200;
export const ORIGIN = "https://relay.example.com";
export const APP = "com.example.yaran";
export const PLAY_APP = "com.example.yaran.play";
export const REG = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";

export function fixture<T = any>(path: string): T {
  return JSON.parse(readFileSync(new URL(`../../node_modules/@yaran/protocol/fixtures/${path}`, import.meta.url), "utf8")) as T;
}

const pem = (label: string, der: ArrayBuffer) =>
  `-----BEGIN ${label}-----\n${Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;

export interface Credentials {
  env: Record<string, string>;
  apnsPublic: CryptoKey;
  fcmPublic: CryptoKey;
}

export async function credentials(over: Record<string, string> = {}): Promise<Credentials> {
  const apns = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const rsa = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const key = () => b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  return {
    apnsPublic: apns.publicKey,
    fcmPublic: rsa.publicKey,
    env: {
      PUBLIC_ORIGIN: ORIGIN,
      APNS_TEAM_ID: "TEAM123456",
      APNS_KEY_ID: "KEY1234567",
      APNS_TOPICS: APP,
      ALLOWED_ENVIRONMENTS: "production,sandbox",
      APNS_P8: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", apns.privateKey)),
      ENDPOINT_KEYS: JSON.stringify({ current: "k2", keys: { k1: key(), k2: key() } }),
      FCM_PROJECT_ID: "yaran-test",
      FCM_APP_IDS: PLAY_APP,
      FCM_SERVICE_ACCOUNT: JSON.stringify({ client_email: "relay@yaran-test.iam.gserviceaccount.com", private_key: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", rsa.privateKey)), token_uri: "https://oauth2.googleapis.com/token" }),
      RL_MINT_PER_MIN: "50",
      RL_KEY_PER_MIN: "600",
      RL_DEVICE_PER_MIN: "5",
      ...over,
    },
  };
}

export async function orgSigner(): Promise<{ signer: VapidSigner; publicKey: string }> {
  const v = fixture("webpush/vapid-vectors.json");
  return { signer: await importVapidPrivateJwk(v.vapid_private_jwk), publicKey: v.vapid_public_key };
}

export interface ApnsCall {
  path: string;
  headers: Record<string, string>;
  body: string;
}

export type ApnsResponder = (call: ApnsCall) => { status: number; body?: string };

/** A mock APNs: `transport` for the core runtime, `listen()` for the Node runtime's http2 client. */
export class MockApns {
  calls: ApnsCall[] = [];
  responder: ApnsResponder = () => ({ status: 200 });
  sessions = 0;
  private server: Http2Server | null = null;

  answer(call: ApnsCall) {
    this.calls.push(call);
    return this.responder(call);
  }

  transport: ApnsTransport = {
    send: async (req) => {
      const url = new URL(req.url);
      const r = this.answer({ path: `${url.host}${url.pathname}`, headers: req.headers, body: req.body });
      return { status: r.status, header: () => null, body: r.body ?? "" };
    },
  };

  /** Starts a cleartext HTTP/2 server; returns its origin. Paths are recorded without a host. */
  async listen(): Promise<string> {
    this.server = createServer();
    this.server.on("session", () => this.sessions++);
    this.server.on("stream", (stream, headers: IncomingHttpHeaders) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) if (!k.startsWith(":") && typeof v === "string") flat[k] = v;
        const r = this.answer({ path: String(headers[":path"]), headers: flat, body: Buffer.concat(chunks).toString("utf8") });
        stream.respond({ ":status": r.status, "content-type": "application/json" });
        stream.end(r.body ?? "");
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

export interface GoogleCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A mock of oauth2.googleapis.com and fcm.googleapis.com behind one fetch. */
export class MockGoogle {
  tokenCalls: GoogleCall[] = [];
  sendCalls: GoogleCall[] = [];
  sendResponder: () => { status: number; body?: string } = () => ({ status: 200, body: '{"name":"projects/yaran-test/messages/1"}' });
  expiresIn = 3600;
  issued = 0;

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call = { url, headers: Object.fromEntries(new Headers(init?.headers)), body: String(init?.body ?? "") };
    if (url === "https://oauth2.googleapis.com/token") {
      this.tokenCalls.push(call);
      return Response.json({ access_token: `ya29.token-${++this.issued}`, expires_in: this.expiresIn, token_type: "Bearer" });
    }
    if (url.startsWith("https://fcm.googleapis.com/v1/projects/")) {
      this.sendCalls.push(call);
      const r = this.sendResponder();
      return new Response(r.body ?? "", { status: r.status });
    }
    throw new TypeError(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

/** Headers for an org Worker's push to the relay. */
export async function pushHeaders(over: Record<string, string | null> = {}, claims?: { aud?: string; exp?: number }): Promise<Record<string, string>> {
  const { signer } = await orgSigner();
  const auth = await signVapid(signer, { aud: claims?.aud ?? ORIGIN, exp: claims?.exp ?? NOW + 12 * 3600, sub: "https://cp.example.org" });
  const h: Record<string, string | null> = { "Content-Encoding": "aes128gcm", TTL: "3600", Urgency: "high", Topic: "ymz4wvfQl4P7VBQ1dIz_qZ4g7zOVj7re", Authorization: auth, ...over };
  return Object.fromEntries(Object.entries(h).filter((e): e is [string, string] => e[1] !== null));
}
