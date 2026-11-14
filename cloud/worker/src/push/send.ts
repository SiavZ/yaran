/**
 * One Web Push request: VAPID header (cached per push-service origin), the RFC 8030
 * headers, the POST itself, and the exhaustive classification of the answer.
 *
 * The JWT has `aud` = endpoint origin, `exp` = now + 12 h and `sub` = the Worker's own
 * https origin, and is reused until an hour before it expires. The private key is imported
 * once per isolate per key, so a rotated key (07) is picked up on the next batch.
 *
 * - The fetch never follows redirects and gives up after 10 s.
 * - Nothing here logs; the consumer logs outcomes without endpoint, token, JWT or payload.
 *
 * <module-headers:begin>
 * Uses:
 * cloud/worker/src/push/send.ts
 * └── cloud/worker/src/push/seams.ts
 * External: @yaran/protocol
 *
 * Used by:
 * cloud/worker/src/push/send.ts
 * ├── cloud/worker/src/push/consumer.ts
 * └── yaran-worker-push-tests:consumer.test.ts
 * <module-headers:end>
 */
import { importVapidPrivateJwk, signVapid, type VapidSigner } from "@yaran/protocol";
import type { PushDeps, PushJob } from "./seams.ts";

export const VAPID_TTL_S = 12 * 3600;
const VAPID_REFRESH_BEFORE_S = 3600;
export const SEND_TIMEOUT_MS = 10_000;
const RETRY_AFTER_DEFAULT_S = 60;
const RETRY_AFTER_MIN_S = 10;
const RETRY_AFTER_MAX_S = 3600;
const BACKOFF_MAX_S = 900;

export type SendOutcome =
  | { kind: "ok"; status: number }
  | { kind: "gone"; status: number }
  | { kind: "auth_failed"; status: number }
  | { kind: "bug"; status: number }
  | { kind: "retry"; status: number; delaySeconds: number };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Seconds from a Retry-After value (delta-seconds or HTTP-date), or null. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.ceil(at / 1000 - now);
}

/** Exponential backoff for 5xx, network errors and timeouts (status 0). */
export function backoffSeconds(attempts: number): number {
  return Math.min(10 * 2 ** attempts, BACKOFF_MAX_S);
}

/** The push service's answer to an action (08's classification table). */
export function classify(status: number, retryAfter: string | null, attempts: number, now: number): SendOutcome {
  if (status >= 200 && status < 300) return { kind: "ok", status };
  if (status === 404 || status === 410) return { kind: "gone", status };
  if (status === 401 || status === 403) return { kind: "auth_failed", status };
  if (status === 429) {
    return { kind: "retry", status, delaySeconds: clamp(parseRetryAfter(retryAfter, now) ?? RETRY_AFTER_DEFAULT_S, RETRY_AFTER_MIN_S, RETRY_AFTER_MAX_S) };
  }
  if (status === 0 || status >= 500) return { kind: "retry", status, delaySeconds: backoffSeconds(attempts) };
  return { kind: "bug", status };
}

/** Per-isolate VAPID signer and token cache; concurrent sends to one origin share one token. */
export class VapidCache {
  private signer: { publicKey: string; signer: Promise<VapidSigner> } | null = null;
  private tokens = new Map<string, { header: Promise<string>; refreshAt: number }>();

  async header(deps: Pick<PushDeps, "vapidKey" | "selfOrigin">, origin: string, now: number): Promise<string> {
    const key = await deps.vapidKey();
    if (this.signer?.publicKey !== key.publicKey) {
      this.signer = { publicKey: key.publicKey, signer: importVapidPrivateJwk(key.privateJwk) };
      this.tokens.clear();
    }
    const cached = this.tokens.get(origin);
    if (cached && now < cached.refreshAt) return cached.header;
    const exp = now + VAPID_TTL_S;
    const header = this.signer.signer.then((signer) => signVapid(signer, { aud: origin, exp, sub: deps.selfOrigin }));
    this.tokens.set(origin, { header, refreshAt: exp - VAPID_REFRESH_BEFORE_S });
    header.catch(() => {
      this.tokens.delete(origin);
      this.signer = null;
    });
    return header;
  }
}

export interface PushResponse {
  status: number;
  retryAfter: string | null;
  text: string;
}

/** POSTs one encrypted body; a network error or timeout answers status 0. */
export async function postPush(
  fetchFn: typeof fetch,
  endpoint: string,
  body: Uint8Array,
  job: PushJob,
  authorization: string,
  now: number,
): Promise<PushResponse> {
  const headers: Record<string, string> = {
    TTL: String(Math.max(0, job.ttl - (now - job.enqueued_at))),
    Urgency: job.urgency,
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    Authorization: authorization,
  };
  if (job.topic !== null) headers.Topic = job.topic;
  try {
    const res = await fetchFn(endpoint, { method: "POST", headers, body: body as BodyInit, redirect: "manual", signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    return { status: res.status, retryAfter: res.headers.get("Retry-After"), text: (await res.text().catch(() => "")).slice(0, 2048) };
  } catch {
    return { status: 0, retryAfter: null, text: "" };
  }
}
