/**
 * Fault plans for the fake Cloudflare: fail the N-th or a matching call, crash after success,
 * 429 with headers, permanent 4xx, non-JSON 5xx and timeouts.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * test/provisioning/fake-cloudflare/faults.ts
 * ├── test/provisioning/crash-matrix.test.ts
 * ├── test/provisioning/fake-cloudflare/index.ts
 * ├── test/provisioning/ops-store.test.ts
 * ├── test/provisioning/origin-port.test.ts
 * ├── test/provisioning/provision.test.ts
 * ├── test/provisioning/rotate.test.ts
 * ├── test/provisioning/tasks.test.ts
 * └── test/provisioning/teardown.test.ts
 * <module-headers:end>
 */

export type FaultKind = "transient" | "crash_after" | "rate_limit" | "permanent" | "timeout" | "non_json";

export interface CallInfo {
  n: number;
  method: string;
  path: string;
}

export interface Fault {
  kind: FaultKind;
  when: (c: CallInfo) => boolean;
  /** Remaining times this fault fires (default 1). */
  times?: number;
}

/** Matches `METHOD path-regex`, e.g. `on("POST", /access\/apps$/)`. */
export const on = (method: string, path: RegExp) => (c: CallInfo) => c.method === method && path.test(c.path);
export const nth = (n: number) => (c: CallInfo) => c.n === n;

export function takeFault(faults: Fault[], c: CallInfo): Fault | null {
  const f = faults.find((x) => (x.times ?? 1) > 0 && x.when(c));
  if (!f) return null;
  f.times = (f.times ?? 1) - 1;
  return f;
}

export function faultResponse(kind: Exclude<FaultKind, "crash_after" | "timeout">): Response {
  switch (kind) {
    case "transient":
      return Response.json({ success: false, errors: [{ code: 10001, message: "service unavailable" }], messages: [], result: null }, { status: 503 });
    case "rate_limit":
      return Response.json(
        { success: false, errors: [{ code: 10000, message: "rate limited" }], messages: [], result: null },
        { status: 429, headers: { "retry-after": "30", ratelimit: '"default";r=0;t=30' } },
      );
    case "permanent":
      return Response.json({ success: false, errors: [{ code: 1001, message: "invalid request \u001b[31mred\u001b[0m" }], messages: [], result: null }, { status: 400 });
    case "non_json":
      return new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
  }
}
