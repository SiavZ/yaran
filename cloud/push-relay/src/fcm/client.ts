/**
 * The G5 fallback channel (fcm_relay): sends 02's FCM data message through the HTTP v1 API
 * with the relay's own service account, for Play builds whose direct VAPID-to-FCM path
 * fails gate G5.
 *
 * The message is `buildRelayFcm` (02: data {v, r, y}, android {priority, ttl, collapse_key}),
 * with the priority written as the API's enum name (HIGH/NORMAL). Answers: 200 delivered;
 * 404 or UNREGISTERED gone; 400 bad_request; 429 rate_limited; 401/403 misconfigured (and the
 * cached access token is dropped); 5xx, network or a failed token exchange unavailable.
 *
 * <module-headers:begin>
 * Uses:
 * src/fcm/client.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/core/upstream.ts
 * └── src/fcm/oauth.ts
 * External: none
 *
 * Used by:
 * src/fcm/client.ts
 * ├── src/core/deps.ts
 * └── test/fcm.test.ts
 * <module-headers:end>
 */
import { buildRelayFcm, type RelayInput } from "@yaran/protocol";
import { upstreamReason, type UpstreamVerdict } from "../core/upstream.ts";
import type { FcmTokenSource } from "./oauth.ts";

export const FCM_TIMEOUT_MS = 10_000;

export class FcmClient {
  private readonly projectId: string;
  private readonly tokens: FcmTokenSource;
  private readonly fetchFn: typeof fetch;

  constructor(projectId: string, tokens: FcmTokenSource, fetchFn: typeof fetch = fetch) {
    this.projectId = projectId;
    this.tokens = tokens;
    this.fetchFn = fetchFn;
  }

  async send(token: string, input: RelayInput): Promise<UpstreamVerdict> {
    const { data, android } = buildRelayFcm(input);
    const message = { token, data, android: { ...android, priority: android.priority.toUpperCase() } };
    let res: Response;
    try {
      const access = await this.tokens.token(input.now);
      res = await this.fetchFn(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
        body: JSON.stringify({ message }),
        redirect: "manual",
        signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
      });
    } catch {
      return { kind: "unavailable", status: 0, reason: "network" };
    }
    const status = res.status;
    if (status === 200) return { kind: "delivered", status };
    const text = await res.text().catch(() => "");
    const reason = text.includes('"UNREGISTERED"') ? "UNREGISTERED" : upstreamReason(text);
    if (status === 404 || reason === "UNREGISTERED") return { kind: "gone", status, reason };
    if (status === 400) return { kind: "bad_request", status, reason };
    if (status === 429) return { kind: "rate_limited", status };
    if (status === 401 || status === 403) {
      this.tokens.invalidate();
      return { kind: "misconfigured", status, reason };
    }
    if (status >= 500) return { kind: "unavailable", status, reason };
    return { kind: "misconfigured", status, reason };
  }
}
