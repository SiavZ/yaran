/**
 * The source org installer's orchestration (`scripts/org-setup/run.ts`) against a fake
 * Cloudflare API, a fake command runner and a fake wizard: fresh setup, resume, refusals
 * before any write, the recovery file, DATA_KEY never rotated, and no secret in any output.
 *
 * <module-headers:begin>
 * Uses:
 * test/node/org-setup.test.ts
 * ├── scripts/org-setup/run.ts
 * ├── scripts/org-setup/state.ts
 * └── test/node/helpers/org-setup-fake.ts
 * External: node:fs, node:path, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, test } from "vitest";
import { runSetup, SECRET_SETTLE_MS, SetupStop } from "../../scripts/org-setup/run.ts";
import { writeState, type OrgState } from "../../scripts/org-setup/state.ts";
import { ACC, api, assertNoLeak, configOf, DB_ID, deployed, harness, OAUTH, opts, repo, RUNTIME, secretPuts, WD, writes } from "./helpers/org-setup-fake.ts";

describe("the org installer", () => {
  test("a fresh account: checks the token first, then creates, deploys, sets secrets and drives setup", async () => {
    const { root, statePath } = repo();
    const a = api();
    const h = harness(a);
    const result = await runSetup(h.ports, opts(root, statePath));
    expect(result).toEqual({ kind: "claimed", host: "cp.example.org" });

    const firstWrite = a.calls.indexOf(writes(a)[0]!);
    const lastProbe = a.calls.map((c) => c.token).lastIndexOf(RUNTIME);
    expect(lastProbe).toBeGreaterThan(0);
    expect(lastProbe).toBeLessThan(firstWrite);
    // Every capability read, the queue list included, comes before the first write.
    expect(a.calls.map((c) => c.path).lastIndexOf("/accounts/acc1/queues?page=1&per_page=100")).toBeLessThan(firstWrite);
    expect(a.dbs.map((d) => d.name)).toEqual(["yaran-cloud"]);
    expect(a.queues).toEqual(["yaran-push"]);

    const state = JSON.parse(readFileSync(statePath, "utf8")) as OrgState;
    expect(state).toMatchObject({ version: 1, accountId: ACC, workerName: "yaran-cloud", hostname: "cp.example.org", workerUrl: WD, adminEmail: "ada@example.org" });
    expect(state.setupCode!.length).toBeGreaterThanOrEqual(24);
    expect(Buffer.from(state.dataKey!, "base64").length).toBe(32);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(statePath)).mode & 0o777).toBe(0o700);

    expect(secretPuts(a)).toEqual([
      { name: "SETUP_CODE", text: state.setupCode, type: "secret_text" },
      { name: "DATA_KEY", text: state.dataKey, type: "secret_text" },
      { name: "CF_API_TOKEN", text: RUNTIME, type: "secret_text" },
    ]);
    const steps = h.commands.map((c) => c.args.slice(0, 2).join(" "));
    expect(steps.indexOf("d1 migrations")).toBeLessThan(steps.indexOf("deploy --config"));
    const config = configOf(root);
    expect(config.d1_databases[0]).toMatchObject({ binding: "DB", database_id: DB_ID, migrations_dir: "../../migrations" });
    expect(config.main).toBe("../../src/index.ts");
    expect(config.vars.APP_CALLBACK_URLS).toBe("https://app.example.org/auth/callback");
    expect(h.commands.find((c) => c.args[0] === "deploy")!.env).toEqual({ CLOUDFLARE_ACCOUNT_ID: ACC });
    expect(h.wizardInputs[0]).toMatchObject({ origin: WD, zoneId: "z1", label: "cp", adminEmail: "ada@example.org", setupCode: state.setupCode, addOneTimePin: false, codeJustSet: true });
    // New secrets get time to reach the edge before the wizard relies on them.
    expect(h.sleeps[0]).toBe(SECRET_SETTLE_MS);
    assertNoLeak(h, root, [RUNTIME, OAUTH, state.setupCode!, state.dataKey!]);
  });

  test("resuming a partly set-up org reuses everything and never replaces DATA_KEY", async () => {
    const { root, statePath } = repo();
    const saved: OrgState = { version: 1, accountId: ACC, workerName: "yaran-cloud", hostname: "cp.example.org", workerUrl: WD, adminEmail: "ada@example.org", setupCode: "s".repeat(32), dataKey: "a".repeat(44), createdAt: "2026-11-16T10:00:00Z" };
    writeState(statePath, saved, false);
    const a = api({
      bindings: [
        { type: "d1", name: "DB", id: DB_ID },
        { type: "queue", name: "PUSH_QUEUE", queue_name: "yaran-push" },
        { type: "plain_text", name: "APP_CALLBACK_URLS", text: "https://kept.example.org/auth/callback" },
        { type: "secret_text", name: "CF_API_TOKEN" },
        { type: "secret_text", name: "SETUP_CODE" },
        { type: "secret_text", name: "DATA_KEY" },
      ],
      dbs: [{ uuid: DB_ID, name: "yaran-cloud" }],
      queues: ["yaran-push"],
      record: { step: "token" },
    });
    const h = harness(a);
    await runSetup(h.ports, opts(root, statePath, { appCallback: undefined }));
    expect(h.tokenAsked).toBe(0);
    expect(writes(a).filter((c) => !c.path.endsWith("/secrets"))).toEqual([]);
    expect(secretPuts(a)).toEqual([{ name: "SETUP_CODE", text: saved.setupCode, type: "secret_text" }]);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual(saved);
    expect(h.sleeps).not.toContain(SECRET_SETTLE_MS);
    expect(h.wizardInputs[0]!.codeJustSet).toBe(false);
    const config = configOf(root);
    expect(config.vars.APP_CALLBACK_URLS).toBe("https://kept.example.org/auth/callback");
  });

  test("a DATA_KEY set before the installer is kept on every run, never generated over", async () => {
    const { root, statePath } = repo();
    const bindings = [{ type: "d1", name: "DB", id: DB_ID }, { type: "queue", name: "PUSH_QUEUE", queue_name: "yaran-push" }, { type: "secret_text", name: "CF_API_TOKEN" }, { type: "secret_text", name: "DATA_KEY" }, { type: "secret_text", name: "SETUP_CODE" }];
    for (let run = 0; run < 2; run++) {
      const a = api({ bindings, dbs: [{ uuid: DB_ID, name: "yaran-cloud" }], queues: ["yaran-push"] });
      const h = harness(a);
      await runSetup(h.ports, opts(root, statePath));
      expect(secretPuts(a).map((s) => s.name)).toEqual(["SETUP_CODE"]);
      expect((JSON.parse(readFileSync(statePath, "utf8")) as OrgState).dataKey).toBeNull();
      if (run === 0) expect(h.logs.join("\n")).toContain("Keeping the Worker's existing DATA_KEY");
    }
  });

  test("a token missing a permission stops before anything is written", async () => {
    const { root, statePath } = repo();
    const a = api({ denied: ["/acct/access/identity_providers"] });
    const h = harness(a);
    const err = await runSetup(h.ports, opts(root, statePath)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SetupStop);
    expect((err as Error).message).toContain("Access: Organizations, Identity Providers, and Groups Edit");
    expect((err as Error).message).toContain("https://dash.cloudflare.com/");
    expect(writes(a)).toEqual([]);
    expect(deployed(h)).toBe(false);
    expect(existsSync(statePath)).toBe(false);
    assertNoLeak(h, root, [RUNTIME, OAUTH], (err as Error).message);
  });

  test("with no token and no way to ask, it names the one credential needed and writes nothing", async () => {
    const { root, statePath } = repo();
    const a = api();
    const h = harness(a, { token: null });
    const err = await runSetup(h.ports, opts(root, statePath)).catch((e: unknown) => e);
    expect((err as Error).message).toContain("needs its own Cloudflare API token");
    expect((err as Error).message).toContain("--token");
    expect(writes(a)).toEqual([]);
    expect(deployed(h)).toBe(false);
  });

  test("a hostname already in use stops before anything is written", async () => {
    const { root, statePath } = repo();
    const a = api({ dns: ["cp.example.org"] });
    const err = await runSetup(harness(a).ports, opts(root, statePath)).catch((e: unknown) => e);
    expect((err as Error).message).toContain("already has a DNS record");
    expect(writes(a)).toEqual([]);
  });

  test("a closed org is left alone: no deploy, no secret, no state", async () => {
    const { root, statePath } = repo();
    const a = api({ bindings: [{ type: "d1", name: "DB", id: DB_ID }, { type: "queue", name: "PUSH_QUEUE", queue_name: "yaran-push" }], dbs: [{ uuid: DB_ID, name: "yaran-cloud" }], record: { step: "closed", cp_host: "cp.example.org" } });
    const h = harness(a);
    expect(await runSetup(h.ports, opts(root, statePath))).toEqual({ kind: "already_closed", host: "cp.example.org" });
    expect(writes(a)).toEqual([]);
    expect(deployed(h)).toBe(false);
    expect(existsSync(statePath)).toBe(false);
  });

  test("an org set up for another hostname, or a Worker that is not yaran's, is refused untouched", async () => {
    const { root, statePath } = repo();
    const other = api({ bindings: [{ type: "d1", name: "DB", id: DB_ID }, { type: "queue", name: "PUSH_QUEUE", queue_name: "yaran-push" }], dbs: [{ uuid: DB_ID, name: "yaran-cloud" }], record: { step: "access", cp_host: "x.example.org" } });
    expect(((await runSetup(harness(other).ports, opts(root, statePath)).catch((e: unknown) => e)) as Error).message).toContain("x.example.org");
    expect(writes(other)).toEqual([]);
    const foreign = api({ bindings: [{ type: "plain_text", name: "X", text: "y" }] });
    expect(((await runSetup(harness(foreign).ports, opts(root, statePath)).catch((e: unknown) => e)) as Error).message).toContain("not a yaran control plane");
    expect(writes(foreign)).toEqual([]);
  });

  test("missing npm trees are installed from their lockfiles first; a missing login stops", async () => {
    const { root, statePath } = repo();
    const h = harness(api(), { installed: false, loggedIn: false });
    const err = await runSetup(h.ports, opts(root, statePath)).catch((e: unknown) => e);
    expect((err as Error).message).toContain("wrangler login");
    const installs = h.commands.filter((c) => c.cmd === "npm");
    expect(installs.map((c) => c.cwd)).toEqual(["cloud/protocol", "cloud/worker", "crates/yaran-web/web"].map((d) => `${root}/${d}`));
    expect(installs.every((c) => c.args[0] === "ci")).toBe(true);
  });

  test("bad inputs are refused before any command runs", async () => {
    const { root, statePath } = repo();
    const h = harness(api());
    await expect(runSetup(h.ports, opts(root, statePath, { label: "yaran-cp" }))).rejects.toThrow("--label");
    await expect(runSetup(h.ports, opts(root, statePath, { domain: "not a domain" }))).rejects.toThrow("--domain");
    expect(h.commands).toEqual([]);
  });
});
