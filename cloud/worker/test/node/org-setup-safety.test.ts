/**
 * The source org installer's safety rails: one run at a time, DATA_KEY never replaced on
 * any evidence it exists, the recovery file's directory and symlink rules, the callback
 * default from publisher.json, another deployment's resources left alone, a resume that
 * cannot change the admin, untrusted error text, and the real CLI under Node.
 *
 * <module-headers:begin>
 * Uses:
 * test/node/org-setup-safety.test.ts
 * ├── scripts/org-setup/run.ts
 * ├── scripts/org-setup/state.ts
 * └── test/node/helpers/org-setup-fake.ts
 * External: node:child_process, node:fs, node:path, node:url, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { runSetup, SetupStop } from "../../scripts/org-setup/run.ts";
import { lockState, readState, writeState, type OrgState } from "../../scripts/org-setup/state.ts";
import { ACC, api, configOf, DB_ID, deployed, harness, opts, repo, secretPuts, WD, writes } from "./helpers/org-setup-fake.ts";

const stop = (run: Promise<unknown>) => run.then(() => expect.fail("the run did not stop"), (e: unknown) => e as Error);
const STATE: OrgState = { version: 1, accountId: ACC, workerName: "yaran-cloud", hostname: "cp.example.org", workerUrl: WD, adminEmail: "ada@example.org", setupCode: "s".repeat(32), dataKey: "a".repeat(44), createdAt: "2026-11-16T10:00:00Z" };
const YARAN_WORKER = [{ type: "d1", name: "DB", id: DB_ID }, { type: "queue", name: "PUSH_QUEUE", queue_name: "yaran-push" }];

describe("one run at a time", () => {
  test("a second run while one is active is refused, so exactly one DATA_KEY is generated and uploaded", async () => {
    const { root, statePath } = repo();
    const a = api();
    const [first, second] = await Promise.allSettled([runSetup(harness(a).ports, opts(root, statePath)), runSetup(harness(a).ports, opts(root, statePath))]);
    expect(first.status).toBe("fulfilled");
    expect(second.status === "rejected" && (second.reason as Error).message).toContain(`${statePath}.lock`);
    const keys = secretPuts(a).filter((s) => s.name === "DATA_KEY");
    expect(keys).toHaveLength(1);
    expect(keys[0]!.text).toBe(readState(statePath)!.dataKey);
    expect(existsSync(`${statePath}.lock`)).toBe(false);
  });

  test("a lock left behind stops the run before anything, and the lock is released after a stop", async () => {
    const { root, statePath } = repo();
    const release = lockState(statePath, false)!;
    const a = api();
    const h = harness(a);
    expect((await stop(runSetup(h.ports, opts(root, statePath)))).message).toContain("delete that file");
    expect(h.commands).toEqual([]);
    release();
    await stop(runSetup(harness(api(), { loggedIn: false }).ports, opts(root, statePath)));
    expect(existsSync(`${statePath}.lock`)).toBe(false);
  });
});

describe("DATA_KEY", () => {
  test("a key listed only by the dedicated secrets endpoint is kept", async () => {
    const { root, statePath } = repo();
    const a = api({ bindings: YARAN_WORKER, secrets: ["DATA_KEY", "CF_API_TOKEN"], dbs: [{ uuid: DB_ID, name: "yaran-cloud" }], queues: ["yaran-push"] });
    await runSetup(harness(a).ports, opts(root, statePath));
    expect(secretPuts(a).map((s) => s.name)).toEqual(["SETUP_CODE"]);
    expect(readState(statePath)!.dataKey).toBeNull();
  });

  test.each([404, 500])("an existing Worker whose secret names answer %i stops before any write", async (status) => {
    const { root, statePath } = repo();
    const a = api({ bindings: YARAN_WORKER, secretsFail: status, dbs: [{ uuid: DB_ID, name: "yaran-cloud" }], queues: ["yaran-push"] });
    const h = harness(a);
    await stop(runSetup(h.ports, opts(root, statePath)));
    expect(writes(a)).toEqual([]);
    expect(deployed(h)).toBe(false);
    expect(existsSync(statePath)).toBe(false);
  });

  test("a key that appears during the run wins: this run's key is never uploaded and leaves the state", async () => {
    const { root, statePath } = repo();
    const a = api();
    const h = harness(a, { onDeploy: () => void (a.secrets = ["DATA_KEY"]) });
    await runSetup(h.ports, opts(root, statePath));
    expect(secretPuts(a).map((s) => s.name)).toEqual(["SETUP_CODE", "CF_API_TOKEN"]);
    expect(readState(statePath)!.dataKey).toBeNull();
    expect(h.logs.join("\n")).toContain("A DATA_KEY appeared");
  });
});

describe("the recovery file", () => {
  test("a --state-file directory the user already had keeps its mode; the file is 0600", () => {
    const { root } = repo();
    const dir = join(root, "mine");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    writeState(join(dir, "org.json"), STATE, false);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(statSync(join(dir, "org.json")).mode & 0o777).toBe(0o600);
    expect(readState(join(dir, "org.json"))).toEqual(STATE);
  });

  test("the installer's own directory is tightened; a missing one is created at 0700", () => {
    const { root } = repo();
    const own = join(root, "own");
    mkdirSync(own, { mode: 0o755 });
    chmodSync(own, 0o755);
    writeState(join(own, "org.json"), STATE, true);
    expect(statSync(own).mode & 0o777).toBe(0o700);
    writeState(join(root, "fresh/org.json"), STATE, false);
    expect(statSync(join(root, "fresh")).mode & 0o777).toBe(0o700);
  });

  test("a symlinked directory or file is refused, and nothing behind it changes", () => {
    const { root } = repo();
    const target = join(root, "target");
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    symlinkSync(target, join(root, "link"));
    expect(() => writeState(join(root, "link/org.json"), STATE, true)).toThrow("symbolic link");
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(existsSync(join(target, "org.json"))).toBe(false);
    writeFileSync(join(target, "real.json"), "{}");
    symlinkSync(join(target, "real.json"), join(root, "org.json"));
    expect(() => readState(join(root, "org.json"))).toThrow("symbolic link");
    expect(() => writeState(join(root, "org.json"), STATE, false)).toThrow("symbolic link");
    expect(readFileSync(join(target, "real.json"), "utf8")).toBe("{}");
  });

  test("a file that is not JSON is reported without echoing its bytes", () => {
    const { root } = repo();
    const path = join(root, "org.json");
    writeFileSync(path, "SECRET-KEY-BYTES-xyz{", { mode: 0o600 });
    expect(() => readState(path)).toThrow(`${path} is not valid JSON.`);
    try {
      readState(path);
    } catch (e) {
      expect((e as Error).message).not.toContain("SECRET");
    }
  });
});

describe("the phone app's callback", () => {
  test("publisher.json's real domain is the default; the placeholder still stops with where to find it", async () => {
    const { root, statePath } = repo();
    writeFileSync(join(root, "publisher.json"), JSON.stringify({ publisher_domain: "<publisher-domain>" }));
    const err = await stop(runSetup(harness(api()).ports, opts(root, statePath, { appCallback: undefined })));
    expect(err.message).toContain("cloud-deploy");
    writeFileSync(join(root, "publisher.json"), JSON.stringify({ publisher_domain: "app.example.net" }));
    await runSetup(harness(api()).ports, opts(root, statePath, { appCallback: undefined }));
    expect(configOf(root).vars.APP_CALLBACK_URLS).toBe("https://app.example.net/auth/callback");
  });
});

describe("another deployment's resources", () => {
  test("an unrelated Worker with a DB binding is refused without migrations, deploy or writes", async () => {
    const { root, statePath } = repo();
    const a = api({ bindings: [{ type: "d1", name: "DB", id: DB_ID }], dbs: [{ uuid: DB_ID, name: "api-prod" }] });
    const h = harness(a);
    expect((await stop(runSetup(h.ports, opts(root, statePath, { name: "api" })))).message).toContain("not a yaran control plane");
    expect(writes(a)).toEqual([]);
    expect(h.commands.some((c) => c.args[0] === "d1" || c.args[0] === "deploy")).toBe(false);
    expect(existsSync(statePath)).toBe(false);
  });

  test("a new Worker never adopts a database or queue no recovery file accounts for", async () => {
    const { root, statePath } = repo();
    const db = api({ dbs: [{ uuid: DB_ID, name: "yaran-cloud" }], record: { step: "token" } });
    expect((await stop(runSetup(harness(db).ports, opts(root, statePath)))).message).toContain("D1 database yaran-cloud already exists");
    expect(writes(db)).toEqual([]);
    const queue = api({ queues: ["yaran-push"] });
    expect((await stop(runSetup(harness(queue).ports, opts(root, statePath)))).message).toContain("queue yaran-push already exists");
    expect(writes(queue)).toEqual([]);
    expect(existsSync(statePath)).toBe(false);
  });

  test("--name gives the control plane its own database and queue", async () => {
    const { root, statePath } = repo();
    const a = api({ dbs: [{ uuid: "other", name: "yaran-cloud" }], queues: ["yaran-push"] });
    await runSetup(harness(a).ports, opts(root, statePath, { name: "acme-cp" }));
    expect(a.dbs.map((d) => d.name)).toEqual(["yaran-cloud", "acme-cp"]);
    expect(a.queues).toEqual(["yaran-push", "acme-cp-push"]);
    const config = configOf(root, "acme-cp");
    expect(config.d1_databases[0]).toMatchObject({ database_name: "acme-cp", database_id: DB_ID });
    expect(config.queues.producers[0].queue).toBe("acme-cp-push");
    expect((await stop(runSetup(harness(a).ports, opts(root, statePath, { name: "other-cp" })))).message).toContain("is for the Worker acme-cp");
  });
});

describe("a resume", () => {
  test("cannot change the first admin once setup recorded one", async () => {
    const { root, statePath } = repo();
    writeState(statePath, STATE, false);
    const world = () =>
      api({
        bindings: [...YARAN_WORKER, { type: "secret_text", name: "CF_API_TOKEN" }, { type: "secret_text", name: "DATA_KEY" }],
        dbs: [{ uuid: DB_ID, name: "yaran-cloud" }],
        queues: ["yaran-push"],
        record: { step: "idp", cp_host: "cp.example.org", admin_email: "ada@example.org" },
      });
    const a = world();
    const err = await stop(runSetup(harness(a).ports, opts(root, statePath, { adminEmail: "bob@example.org" })));
    expect(err).toBeInstanceOf(SetupStop);
    expect(err.message).toContain("ada@example.org");
    expect(writes(a)).toEqual([]);
    const h = harness(world());
    await runSetup(h.ports, opts(root, statePath, { adminEmail: "Ada@Example.org" }));
    expect(h.wizardInputs[0]!.adminEmail).toBe("ada@example.org");
  });
});

test("Cloudflare error text that echoes a secret is redacted and stripped of control characters", async () => {
  const { root, statePath } = repo();
  const a = api({ echoSecretPut: true });
  const err = await stop(runSetup(harness(a).ports, opts(root, statePath)));
  const code = readState(statePath)!.setupCode!;
  expect(err.message).toContain("[redacted]");
  expect(err.message).not.toContain(code);
  expect(err.message).not.toContain("\u001b");
  expect(err.message.length).toBeLessThan(300);
});

describe("the real CLI under Node's own type stripping", () => {
  const cli = fileURLToPath(new URL("../../scripts/setup.ts", import.meta.url));
  const node = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: dirname(cli), encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });

  test("--help loads the whole static import graph and prints the usage", () => {
    const r = node("--help");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: node cloud/worker/scripts/setup.ts --domain <zone>");
  });

  test("an unknown flag prints the problem and the usage, never a stack trace", () => {
    const r = node("--bogus");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--bogus");
    expect(r.stderr).toContain("Usage:");
    expect(r.stderr).not.toMatch(/^\s+at /m);
    expect(node().status).toBe(2);
  });
});
