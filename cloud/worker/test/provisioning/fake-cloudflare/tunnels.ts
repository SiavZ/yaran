/**
 * Fake tunnel endpoints: create (409 on a live duplicate name), get, list with filters, secret
 * rotation, token, configuration, connection eviction and delete (refused while connected).
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/fake-cloudflare/tunnels.ts
 * ├── test/provisioning/fake-cloudflare/envelope.ts
 * └── test/provisioning/fake-cloudflare/state.ts
 * External: none
 *
 * Used by:
 * test/provisioning/fake-cloudflare/tunnels.ts
 * └── test/provisioning/fake-cloudflare/index.ts
 * <module-headers:end>
 */
import { fail, match, notFound, ok, paged, type FakeReq } from "./envelope.ts";
import { LIMITS, type FakeState, type FakeTunnel } from "./state.ts";

export interface TunnelOptions {
  /** Whether create and rotate responses carry `token` (the schema omits it). */
  tokenInResponse: boolean;
}

const view = (t: FakeTunnel) => ({
  id: t.id,
  name: t.name,
  status: t.status,
  created_at: "2026-11-14T00:00:00Z",
  deleted_at: t.deleted_at,
  conns_active_at: t.conns_active_at,
  conns_inactive_at: null,
  tun_type: "cfd_tunnel",
  config_src: "cloudflare",
});

export function tunnelRoutes(st: FakeState, o: TunnelOptions) {
  const token = (t: FakeTunnel) => {
    const tok = btoa(JSON.stringify({ a: "acct", t: t.id, s: t.secret }));
    st.issued.push(tok);
    return tok;
  };
  return (req: FakeReq): Response | null => {
    const { method, path, query, body } = req;
    if (match(path, /^\/accounts\/[^/]+\/cfd_tunnel$/)) {
      if (method === "GET") {
        let items = [...st.tunnels.values()];
        if (query.get("is_deleted") === "false") items = items.filter((t) => !t.deleted_at);
        const name = query.get("name");
        if (name) items = items.filter((t) => t.name === name);
        const prefix = query.get("include_prefix");
        if (prefix) items = items.filter((t) => t.name.startsWith(prefix));
        return paged(items.map(view), query);
      }
      if (method === "POST") {
        const name = String(body?.["name"] ?? "");
        if (st.liveTunnels().some((t) => t.name === name)) return fail(409, 1013, "You already have a tunnel with this name");
        if (st.liveTunnels().length >= LIMITS.tunnels) return fail(400, 1014, "Tunnel limit reached");
        const t: FakeTunnel = {
          id: st.uuid(), name, secret: st.hex(64), connectors: 0, rogue: false, status: "inactive",
          deleted_at: null, config: null, configVersion: 0, conns_active_at: null,
        };
        st.tunnels.set(t.id, t);
        return ok(o.tokenInResponse ? { ...view(t), token: token(t) } : view(t));
      }
    }
    const one = match(path, /^\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)(\/token|\/configurations|\/connections)?$/);
    if (!one) return null;
    const [id, sub] = one;
    const t = st.tunnels.get(id ?? "");
    if (!t || (t.deleted_at && (sub !== undefined || method !== "GET"))) return notFound();
    switch (`${method} ${sub ?? ""}`) {
      case "GET ":
        return ok(view(t));
      case "PATCH ": {
        if (typeof body?.["tunnel_secret"] === "string") {
          t.secret = body["tunnel_secret"];
          t.rogue = false;
        }
        return ok(o.tokenInResponse ? { ...view(t), token: token(t) } : view(t));
      }
      case "DELETE ":
        if (t.connectors > 0) return fail(400, 1022, "Cannot delete tunnel because it has active connections");
        t.deleted_at = "2026-11-14T00:00:00Z";
        return ok(view(t));
      case "GET /token":
        return ok(token(t));
      case "GET /configurations":
        return ok({ tunnel_id: t.id, version: t.configVersion, config: t.config, source: "cloudflare" });
      case "PUT /configurations":
        t.config = body?.["config"] ?? null;
        t.configVersion++;
        return ok({ tunnel_id: t.id, version: t.configVersion, config: t.config, source: "cloudflare" });
      case "DELETE /connections":
        t.connectors = t.rogue ? 1 : 0;
        return ok(null);
      default:
        return fail(405, 10000, "Method not allowed");
    }
  };
}
