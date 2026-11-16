/**
 * Sends one relayed message to APNs and maps the answer onto an `UpstreamVerdict`.
 *
 * The request body and apns-* headers are 02's (`buildRelayApns`, pinned by
 * fixtures/push/relay-wrapping.json): high/normal Urgency is an alert the NSE rewrites
 * (priority 10/5), low/very-low a background push; the Topic becomes apns-collapse-id and
 * thread-id. The host follows the endpoint's environment.
 *
 * Answer mapping: 200 delivered; 410, and 400 BadDeviceToken/DeviceTokenNotForTopic, gone
 * (the endpoint can never work); other 400 bad_request; 413 too_large; 429 rate_limited;
 * 403 (provider token errors) and any other status misconfigured; 5xx or network
 * unavailable.
 *
 * <module-headers:begin>
 * Uses:
 * src/apns/client.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/apns/jwt.ts
 * ├── src/apns/transport.ts
 * ├── src/core/config.ts
 * └── src/core/upstream.ts
 * External: none
 *
 * Used by:
 * src/apns/client.ts
 * └── src/core/deps.ts
 * <module-headers:end>
 */
import { buildRelayApns, type RelayInput } from "@yaran/protocol";
import type { ApnsEnvironment } from "../core/config.ts";
import { upstreamReason, type UpstreamVerdict } from "../core/upstream.ts";
import type { ProviderTokenCache } from "./jwt.ts";
import type { ApnsTransport } from "./transport.ts";

export const APNS_HOSTS: Record<ApnsEnvironment, string> = { production: "api.push.apple.com", sandbox: "api.sandbox.push.apple.com" };
export const APNS_MAX_PAYLOAD = 4096;
const GONE_400 = new Set(["BadDeviceToken", "DeviceTokenNotForTopic"]);

export interface ApnsTarget {
  token: string;
  environment: ApnsEnvironment;
}

export class ApnsClient {
  private readonly transport: ApnsTransport;
  private readonly tokens: ProviderTokenCache;

  constructor(transport: ApnsTransport, tokens: ProviderTokenCache) {
    this.transport = transport;
    this.tokens = tokens;
  }

  async send(target: ApnsTarget, input: RelayInput): Promise<UpstreamVerdict> {
    const { headers, payload } = buildRelayApns(input);
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).length > APNS_MAX_PAYLOAD) return { kind: "too_large", status: 413 };
    let res;
    try {
      res = await this.transport.send({
        url: `https://${APNS_HOSTS[target.environment]}/3/device/${target.token}`,
        headers: { ...headers, authorization: `bearer ${await this.tokens.token(input.now)}`, "content-type": "application/json" },
        body,
      });
    } catch {
      return { kind: "unavailable", status: 0, reason: "network" };
    }
    const status = res.status;
    if (status === 200) return { kind: "delivered", status };
    const reason = upstreamReason(res.body);
    if (status === 410 || (status === 400 && GONE_400.has(reason))) return { kind: "gone", status, reason };
    if (status === 400) return { kind: "bad_request", status, reason };
    if (status === 413) return { kind: "too_large", status };
    if (status === 429) return { kind: "rate_limited", status };
    if (status >= 500) return { kind: "unavailable", status, reason };
    return { kind: "misconfigured", status, reason };
  }
}
