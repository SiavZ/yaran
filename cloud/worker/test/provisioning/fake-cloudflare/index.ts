/**
 * The fake Cloudflare API used by the provisioning tests: a `fetch` bound to
 * api.cloudflare.com with in-memory state, a call log, rate-limit headers and fault plans.
 *
 * The engine's client takes `fetch` as a dependency, so this replaces msw: the same client
 * code runs, only the network is swapped. The D21 invariants are checked after every call.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/fake-cloudflare/index.ts
 * ├── test/provisioning/fake-cloudflare/access.ts
 * ├── test/provisioning/fake-cloudflare/dns.ts
 * ├── test/provisioning/fake-cloudflare/envelope.ts
 * ├── test/provisioning/fake-cloudflare/faults.ts
 * ├── test/provisioning/fake-cloudflare/state.ts
 * └── test/provisioning/fake-cloudflare/tunnels.ts
 * External: none
 *
 * Used by:
 * test/provisioning/fake-cloudflare/index.ts
 * ├── test/provisioning/fixture-contract.test.ts
 * └── test/provisioning/helpers/world.ts
 * <module-headers:end>
 */
import { accessRoutes } from "./access.ts";
import { dnsRoutes } from "./dns.ts";
import type { FakeReq } from "./envelope.ts";
import { fail } from "./envelope.ts";
import { faultResponse, takeFault, type Fault } from "./faults.ts";
import { FakeState } from "./state.ts";
import { tunnelRoutes } from "./tunnels.ts";

export const FAKE_BASE = "https://api.cloudflare.com/client/v4";

export interface CallLogEntry {
  method: string;
  path: string;
  query: string;
  status: number;
  body: unknown;
  authorization: string | null;
}

export interface FakeCloudflare {
  fetch: typeof fetch;
  state: FakeState;
  calls: CallLogEntry[];
  faults: Fault[];
  /** Called when a `crash_after` fault fires, after the call was applied. */
  onCrash: () => void;
  /** Budget the `Ratelimit` header reports; decremented per call. */
  remaining: number;
  options: { tokenInResponse: boolean };
}

export function createFakeCloudflare(opts: { tokenInResponse?: boolean; base?: string } = {}): FakeCloudflare {
  const state = new FakeState();
  const base = opts.base ?? FAKE_BASE;
  const fake: FakeCloudflare = {
    state,
    calls: [],
    faults: [],
    onCrash: () => {},
    remaining: 1200,
    options: { tokenInResponse: opts.tokenInResponse ?? true },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const path = url.pathname.replace(new URL(base).pathname, "");
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      const n = fake.calls.length + 1;
      const entry: CallLogEntry = { method, path, query: url.search, status: 0, body, authorization: headers.get("authorization") };
      fake.calls.push(entry);
      const fault = takeFault(fake.faults, { n, method, path });
      if (fault?.kind === "timeout") {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      let res: Response;
      if (fault && fault.kind !== "crash_after") {
        res = faultResponse(fault.kind);
      } else {
        const req: FakeReq = { method, path, query: url.searchParams, body };
        const routes = [tunnelRoutes(state, fake.options), dnsRoutes(state), accessRoutes(state)];
        res = routes.reduce<Response | null>((r, h) => r ?? h(req), null) ?? fail(404, 7003, "No route for that URI");
        state.checkInvariants(`${method} ${path}`);
        if (fault?.kind === "crash_after") fake.onCrash();
      }
      fake.remaining = Math.max(0, fake.remaining - 1);
      if (res.status !== 429) res.headers.set("ratelimit", `"default";r=${fake.remaining};t=300`);
      entry.status = res.status;
      return res;
    },
  };
  return fake;
}
