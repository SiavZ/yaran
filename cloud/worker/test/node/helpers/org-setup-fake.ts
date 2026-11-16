/**
 * A fake Cloudflare API, command runner and wizard for the source org installer's tests.
 * Paths and response shapes follow the endpoints the installer reads: Worker settings and
 * its dedicated secret-name list, D1 by name and id, the queue list's `queue_name`.
 *
 * <module-headers:begin>
 * Uses:
 * test/node/helpers/org-setup-fake.ts
 * ├── scripts/org-setup/run.ts
 * └── scripts/org-setup/wizard.ts
 * External: node:fs, node:os, node:path, vitest
 *
 * Used by:
 * test/node/helpers/org-setup-fake.ts
 * ├── test/node/org-setup-safety.test.ts
 * └── test/node/org-setup.test.ts
 * <module-headers:end>
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type { SetupOptions, SetupPorts } from "../../../scripts/org-setup/run.ts";
import type { WizardInput } from "../../../scripts/org-setup/wizard.ts";

export const ACC = "acc1";
export const OAUTH = "oauth-login-token-value";
export const RUNTIME = "runtime-api-token-value";
export const DB_ID = "11111111-2222-3333-4444-555555555555";
export const WD = "https://yaran-cloud.acme.workers.dev";

export interface Binding {
  type: string;
  name: string;
  id?: string;
  queue_name?: string;
  text?: string;
}

export interface Api {
  bindings: Binding[] | null;
  /** The dedicated secrets endpoint's names; undefined derives them from `bindings`, null answers 404. */
  secrets?: string[] | null;
  /** An HTTP status the secrets endpoint fails with. */
  secretsFail?: number;
  /** Secret PUTs fail with an error message echoing the request body. */
  echoSecretPut?: boolean;
  dbs: { uuid: string; name: string }[];
  queues: string[];
  record: { step: string; cp_host?: string; admin_email?: string } | null;
  /** Runtime-token probe paths that answer 403. */
  denied: string[];
  dns: string[];
  calls: { method: string; path: string; token: string; body: string }[];
}

export function api(over: Partial<Api> = {}): Api {
  return { bindings: null, dbs: [], queues: [], record: null, denied: [], dns: [], calls: [], ...over };
}

const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
const fail = (status: number, message = "nope") => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message }], result: null }), { status });

function fakeFetch(a: Api): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host.endsWith("workers.dev")) return new Response(JSON.stringify({ setup: "open" }));
    if (url.host === "cp.example.org") return new Response(JSON.stringify({ setup: "closed" }));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/client/v4", "");
    const token = new Headers(init?.headers).get("Authorization")!.replace("Bearer ", "");
    const body = String(init?.body ?? "");
    a.calls.push({ method, path: path + url.search, token, body });
    const p = path.replace(/^\/accounts\/[^/]+/, "/acct");
    if (token === RUNTIME) {
      if (a.denied.some((d) => p.startsWith(d))) return fail(403);
      if (p === "/accounts") return ok([{ id: ACC, name: "Example" }]);
      if (p === "/zones") return ok([{ id: "z1", name: "example.org" }]);
      if (p === "/zones/z1/dns_records") return ok(a.dns.filter((n) => n === url.searchParams.get("name")).map((n) => ({ id: n })));
      if (p === "/acct/workers/domains" || p === "/acct/cfd_tunnel" || p === "/acct/access/apps") return ok([]);
      if (p === "/acct/access/identity_providers") return ok([{ id: "g", name: "Google", type: "google" }]);
      if (p.startsWith("/acct/workers/scripts/")) return a.bindings ? ok({}) : fail(404);
      return fail(404);
    }
    expect(token).toBe(OAUTH);
    if (p === "/acct/workers/subdomain") return ok({ subdomain: "acme" });
    if (/^\/acct\/workers\/scripts\/[^/]+\/settings$/.test(p)) return a.bindings ? ok({ bindings: a.bindings }) : fail(404);
    if (/^\/acct\/workers\/scripts\/[^/]+\/secrets$/.test(p) && method === "GET") {
      if (a.secretsFail) return fail(a.secretsFail);
      const names = a.secrets === undefined ? a.bindings?.filter((b) => b.type === "secret_text").map((b) => b.name) : a.secrets;
      return names ? ok(names.map((name) => ({ name, type: "secret_text" }))) : fail(404);
    }
    if (/^\/acct\/workers\/scripts\/[^/]+\/secrets$/.test(p) && method === "PUT") return a.echoSecretPut ? fail(400, `\u001b[31mbad secret ${body}`) : ok({});
    if (p === "/acct/d1/database" && method === "GET") return ok(a.dbs.filter((d) => d.name === url.searchParams.get("name")));
    if (p === "/acct/d1/database" && method === "POST") {
      const db = { uuid: DB_ID, name: JSON.parse(body).name };
      a.dbs.push(db);
      return ok(db);
    }
    if (p === `/acct/d1/database/${DB_ID}`) return ok(a.dbs.find((d) => d.uuid === DB_ID));
    if (p === `/acct/d1/database/${DB_ID}/query`) return ok([{ results: a.record ? [{ value: JSON.stringify(a.record) }] : [] }]);
    if (p === "/acct/queues" && method === "GET") return ok(a.queues.map((queue_name) => ({ queue_name })));
    if (p === "/acct/queues" && method === "POST") return ok(a.queues.push(JSON.parse(body).queue_name));
    if (p === "/zones") return ok([{ id: "z1", name: "example.org" }]);
    return fail(404);
  }) as typeof fetch;
}

export function repo(): { root: string; statePath: string } {
  const root = mkdtempSync(join(tmpdir(), "org-setup-"));
  mkdirSync(join(root, "cloud/worker"), { recursive: true });
  copyFileSync(new URL("../../../wrangler.jsonc", import.meta.url), join(root, "cloud/worker/wrangler.jsonc"));
  return { root, statePath: join(root, "home/.yaran/cloud-setup/cp.example.org.json") };
}

export interface Harness {
  ports: SetupPorts;
  logs: string[];
  commands: { cmd: string; args: string[]; cwd: string; env: Record<string, string> | undefined }[];
  wizardInputs: WizardInput[];
  sleeps: number[];
  tokenAsked: number;
}

export interface HarnessOptions {
  token?: string | null;
  installed?: boolean;
  loggedIn?: boolean;
  /** Runs when the installer deploys, to change the fake account mid-run. */
  onDeploy?: () => void | Promise<void>;
}

export function harness(a: Api, o: HarnessOptions = {}): Harness {
  const h: Harness = { logs: [], commands: [], wizardInputs: [], sleeps: [], tokenAsked: 0, ports: undefined as never };
  h.ports = {
    run: async (cmd, args, ro) => {
      h.commands.push({ cmd, args, cwd: ro.cwd, env: ro.env });
      if (args[0] === "whoami") return o.loggedIn === false ? { code: 1, stdout: "" } : { code: 0, stdout: JSON.stringify({ loggedIn: true, email: "Ada@Example.org", accounts: [{ id: ACC, name: "Example" }] }) };
      if (args[0] === "auth") return { code: 0, stdout: JSON.stringify({ type: "oauth", token: OAUTH }) };
      if (args[0] === "deploy") {
        if (a.bindings === null && a.secrets === undefined) a.secrets = [];
        await o.onDeploy?.();
      }
      return { code: 0, stdout: "" };
    },
    fetch: fakeFetch(a),
    sleep: async (ms) => {
      h.sleeps.push(ms);
    },
    log: (l) => h.logs.push(l),
    exists: () => o.installed !== false,
    readToken: async () => {
      h.tokenAsked++;
      return o.token === undefined ? RUNTIME : o.token;
    },
    openUrl: () => {},
    now: () => new Date("2026-11-16T12:00:00Z"),
    wizard: async (_io, input) => {
      h.wizardInputs.push(input);
      return { kind: "claim", link: "https://cp.example.org/setup/claim?c=one-time" };
    },
  };
  return h;
}

export const opts = (root: string, statePath: string, more: Partial<SetupOptions> = {}): SetupOptions => ({
  repoRoot: root,
  domain: "example.org",
  stateFile: statePath,
  appCallback: "https://app.example.org/auth/callback",
  claimWaitMs: 0,
  ...more,
});

export const writes = (a: Api) => a.calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/query"));
export const deployed = (h: Harness) => h.commands.some((c) => c.args.includes("deploy") || c.args.includes("migrations"));
export const secretPuts = (a: Api) => writes(a).filter((c) => c.path.endsWith("/secrets")).map((c) => JSON.parse(c.body) as { name: string; text: string });
export const configOf = (root: string, worker = "yaran-cloud") => JSON.parse(readFileSync(join(root, `cloud/worker/.wrangler/yaran-org/wrangler.${worker}.json`), "utf8"));

/** No secret value may reach a log line, a command, its environment, or the generated config. */
export function assertNoLeak(h: Harness, root: string, secrets: string[], extra = ""): void {
  const config = join(root, "cloud/worker/.wrangler/yaran-org/wrangler.yaran-cloud.json");
  const out = [h.logs.join("\n"), JSON.stringify(h.commands), existsSync(config) ? readFileSync(config, "utf8") : "", extra].join("\n");
  for (const s of secrets) if (s) expect(out).not.toContain(s);
}
