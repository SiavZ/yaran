/**
 * Fake Access app and reusable policy endpoints, with the 500 caps, `domain` + `exact`
 * filtering, whole-object PUT, 202 app delete, and detach-before-delete for policies.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/fake-cloudflare/access.ts
 * ├── test/provisioning/fake-cloudflare/envelope.ts
 * └── test/provisioning/fake-cloudflare/state.ts
 * External: none
 *
 * Used by:
 * test/provisioning/fake-cloudflare/access.ts
 * └── test/provisioning/fake-cloudflare/index.ts
 * <module-headers:end>
 */
import { fail, match, notFound, ok, paged, type FakeReq } from "./envelope.ts";
import { LIMITS, type FakeApp, type FakePolicy, type FakeState } from "./state.ts";

export function accessRoutes(st: FakeState) {
  return (req: FakeReq): Response | null => {
    const { method, path, query, body } = req;
    // Phase 06: revoke a user's Access sessions (sign out everywhere).
    if (match(path, /^\/accounts\/[^/]+\/access\/organizations\/revoke_user$/)) return method === "POST" ? ok(null) : null;
    if (match(path, /^\/accounts\/[^/]+\/access\/apps$/)) {
      if (method === "GET") {
        let items = [...st.apps.values()];
        const domain = query.get("domain");
        if (domain) items = items.filter((a) => (query.get("exact") === "true" ? a["domain"] === domain : String(a["domain"]).includes(domain)));
        return paged(items, query);
      }
      if (method === "POST") {
        if (st.apps.size >= LIMITS.apps) return fail(400, 12130, "access.api.error.application_limit_reached");
        const app: FakeApp = { ...(body ?? {}), id: st.uuid(), aud: st.hex(64), created_at: "2026-11-14T00:00:00Z" };
        st.apps.set(app.id, app);
        return ok(app, 201);
      }
      return null;
    }
    const app = match(path, /^\/accounts\/[^/]+\/access\/apps\/([^/]+)$/);
    if (app) {
      const a = st.apps.get(app[0] ?? "");
      if (!a) return notFound();
      if (method === "GET") return ok(a);
      if (method === "PUT") {
        const next: FakeApp = { ...(body ?? {}), id: a.id, aud: a.aud, created_at: a["created_at"] };
        st.apps.set(a.id, next);
        return ok(next);
      }
      if (method === "DELETE") {
        st.apps.delete(a.id);
        return ok({ id: a.id }, 202);
      }
      return fail(405, 10000, "Method not allowed");
    }
    if (match(path, /^\/accounts\/[^/]+\/access\/policies$/)) {
      if (method === "GET") return paged([...st.policies.values()].map((p) => ({ ...p, app_count: st.appCount(p.id) })), query);
      if (method === "POST") {
        if (st.policies.size >= LIMITS.policies) return fail(400, 12131, "access.api.error.policy_limit_reached");
        const p: FakePolicy = { name: String(body?.["name"]), decision: String(body?.["decision"]), include: (body?.["include"] as unknown[]) ?? [], id: st.uuid() };
        st.policies.set(p.id, p);
        return ok({ ...p, app_count: 0 }, 201);
      }
      return null;
    }
    const pol = match(path, /^\/accounts\/[^/]+\/access\/policies\/([^/]+)$/);
    if (!pol) return null;
    const p = st.policies.get(pol[0] ?? "");
    if (!p) return notFound();
    if (method === "GET") return ok({ ...p, app_count: st.appCount(p.id) });
    if (method === "PUT") {
      Object.assign(p, { name: body?.["name"], decision: body?.["decision"], include: body?.["include"] });
      return ok({ ...p, app_count: st.appCount(p.id) });
    }
    if (method === "DELETE") {
      if (st.appCount(p.id) > 0) return fail(400, 12132, "access.api.error.policy_in_use");
      st.policies.delete(p.id);
      return ok({ id: p.id });
    }
    return fail(405, 10000, "Method not allowed");
  };
}
