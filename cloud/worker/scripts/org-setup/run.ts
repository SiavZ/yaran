/**
 * The org installer's orchestration: one run takes a Cloudflare account with a Wrangler
 * login to a deployed control plane waiting only for the admin's Access sign-in.
 *
 * Order, chosen so nothing is created that a later check could have refused:
 * 0. Take the recovery file's exclusive lock: one run at a time generates and uploads keys.
 * 1. Bootstrap the pinned npm dependencies that are missing, then read the Wrangler login.
 * 2. Read what exists: the Worker, its bindings and secret names, its D1 database and
 *    queue, the wizard record. A closed (live) org, one set up for another hostname, or a
 *    database or queue another deployment may own stops here untouched.
 * 3. Check every input and, when a new runtime API token is supplied, run the Worker's
 *    own capability probe and zone checks with it. Still nothing written.
 * 4. Save the recovery file (SETUP_CODE, DATA_KEY), then reuse or create the D1 database
 *    and queue, build the console assets, apply migrations and deploy this Worker only,
 *    from a generated config under the ignored `.wrangler/` directory.
 * 5. Upload the bootstrap secrets by API body, and drive the Worker's own setup wizard to
 *    the claim link. An existing DATA_KEY is never replaced: the secret names are read
 *    again right before that upload. After a secret changes the run waits for it to
 *    reach Cloudflare's edge before the wizard tries the setup code.
 *
 * <module-headers:begin>
 * Uses:
 * scripts/org-setup/run.ts
 * ├── scripts/callback-urls.ts
 * ├── scripts/org-setup/cloudflare.ts
 * ├── scripts/org-setup/state.ts
 * ├── scripts/org-setup/wizard.ts
 * ├── scripts/update/merge-wrangler.ts
 * ├── src/cloudflare/errors.ts
 * ├── src/setup/capability-probe.ts
 * ├── src/setup/steps/idp.ts
 * ├── src/setup/steps/zone.ts
 * └── src/setup/token-template.ts
 * External: node:fs, node:path
 *
 * Used by:
 * scripts/org-setup/run.ts
 * ├── scripts/setup.ts
 * ├── test/node/helpers/org-setup-fake.ts
 * ├── test/node/org-setup-safety.test.ts
 * └── test/node/org-setup.test.ts
 * <module-headers:end>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { CfApiError } from "../../src/cloudflare/errors.ts";
import { publisherCallbacks } from "../callback-urls.ts";
import { probeCapabilities, probePassed, resolveAccount } from "../../src/setup/capability-probe.ts";
import { listIdps, usableIdps } from "../../src/setup/steps/idp.ts";
import { chooseHostname, DEFAULT_LABEL, listZones } from "../../src/setup/steps/zone.ts";
import { PERMISSIONS, tokenTemplateUrl } from "../../src/setup/token-template.ts";
import { account, cfTransport, type ScriptBinding } from "./cloudflare.ts";
import { defaultStatePath, lockState, newDataKey, newSetupCode, readState, writeState, type OrgState } from "./state.ts";
import { driveWizard, SetupStop, type WizardInput, type WizardIo, type WizardOutcome } from "./wizard.ts";

export { SetupStop };

export type Runner = (cmd: string, args: string[], o: { cwd: string; env?: Record<string, string>; capture?: boolean }) => Promise<{ code: number; stdout: string }>;

export interface SetupPorts {
  run: Runner;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  exists: (path: string) => boolean;
  /** Asks for the runtime API token without echoing it; null when there is no way to ask. */
  readToken: () => Promise<string | null>;
  openUrl: (url: string) => void;
  now: () => Date;
  wizard?: (io: WizardIo, input: WizardInput) => Promise<WizardOutcome>;
}

export interface SetupOptions {
  repoRoot: string;
  domain: string;
  label?: string | undefined;
  adminEmail?: string | undefined;
  accountId?: string | undefined;
  name?: string | undefined;
  team?: string | undefined;
  appCallback?: string | undefined;
  stateFile?: string | undefined;
  /** Supply a new runtime API token even though the Worker already has one. */
  newToken?: boolean | undefined;
  /** Allow adding One-time PIN when Zero Trust has no other sign-in method. */
  oneTimePin?: boolean | undefined;
  claimWaitMs?: number | undefined;
}

export type SetupResult = { kind: "already_closed"; host: string } | { kind: "claimed"; host: string } | { kind: "claim_pending"; host: string; link: string };

const RESUME = "Rerun the same command to resume.";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LABEL = /^[a-z0-9]{1,63}$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
/** How long a changed secret gets to reach every Cloudflare location before the wizard relies on it. */
export const SECRET_SETTLE_MS = 30_000;
const tokenAdvice = (zone: string) => `Create it from ${tokenTemplateUrl()}\nwith the two zone rows limited to ${zone}, then rerun with --token and paste it when asked.`;

/** Reads `npm`'s pinned trees in, only where they are missing. */
async function bootstrap(p: SetupPorts, root: string): Promise<void> {
  const trees: [string, string, string[]][] = [
    ["cloud/protocol", "node_modules/jose", ["ci", "--no-audit", "--no-fund"]],
    ["cloud/worker", "node_modules/.bin/wrangler", ["ci", "--no-audit", "--no-fund"]],
    // Only for the console font (copy-ui-kit-assets.ts); its build scripts are not needed.
    ["crates/yaran-web/web", "node_modules/@fontsource-variable/geist", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]],
  ];
  for (const [dir, marker, args] of trees) {
    if (p.exists(join(root, dir, marker))) continue;
    p.log(`Installing the pinned dependencies in ${dir}.`);
    await must(p, "npm", args, { cwd: join(root, dir) }, `npm ci in ${dir}`);
  }
}

async function must(p: SetupPorts, cmd: string, args: string[], o: Parameters<Runner>[2], what: string): Promise<string> {
  const r = await p.run(cmd, args, o);
  if (r.code !== 0) throw new SetupStop(`${what} failed (exit ${r.code}); see its output above. ${RESUME}`);
  return r.stdout;
}

function json<T>(text: string, what: string): T {
  const start = text.indexOf("{");
  try {
    return JSON.parse(text.slice(start)) as T;
  } catch {
    throw new SetupStop(`Could not read ${what}. ${RESUME}`);
  }
}

const binding = (b: ScriptBinding[] | null, type: string, name: string) => b?.find((x) => x.type === type && x.name === name);

export async function runSetup(p: SetupPorts, o: SetupOptions): Promise<SetupResult> {
  const domain = o.domain.trim().toLowerCase().replace(/\.$/, "");
  const label = (o.label ?? DEFAULT_LABEL).trim().toLowerCase();
  if (!DOMAIN.test(domain)) throw new SetupStop("--domain must be your Cloudflare zone, for example example.org.");
  if (!LABEL.test(label)) throw new SetupStop("--label must be 1 to 63 lowercase letters or digits, with no hyphen.");
  const host = `${label}.${domain}`;
  const statePath = o.stateFile ?? defaultStatePath(host);
  // Only the installer's own default directory is ever tightened; a --state-file's is the user's.
  const own = o.stateFile === undefined;
  const release = lockState(statePath, own);
  if (!release) throw new SetupStop(`Another installer run holds ${statePath}.lock. If none is running (a killed run can leave it behind), delete that file and rerun.`);
  try {
    return await install(p, o, { domain, label, host, statePath, own });
  } finally {
    release();
  }
}

async function install(p: SetupPorts, o: SetupOptions, { domain, label, host, statePath, own }: { domain: string; label: string; host: string; statePath: string; own: boolean }): Promise<SetupResult> {
  const saved = readState(statePath);
  if (saved && saved.hostname !== host) throw new SetupStop(`${statePath} is for ${saved.hostname}, not ${host}.`);

  const workerDir = join(o.repoRoot, "cloud/worker");
  await bootstrap(p, o.repoRoot);
  const wrangler = join(workerDir, "node_modules/.bin/wrangler");
  const who = await p.run(wrangler, ["whoami", "--json"], { cwd: workerDir, capture: true });
  if (who.code !== 0) throw new SetupStop("Wrangler is not logged in. Run `npx wrangler login` in cloud/worker, then rerun.");
  const me = json<{ email?: string; accounts?: { id: string; name: string }[] }>(who.stdout, "the Wrangler login");
  const accounts = me.accounts ?? [];
  const accountId = o.accountId ?? saved?.accountId ?? (accounts.length === 1 ? accounts[0]!.id : undefined);
  if (!accountId) throw new SetupStop(`Your login sees ${accounts.length} accounts; pass --account-id with one of: ${accounts.map((a) => `${a.id} (${a.name})`).join(", ")}.`);
  if (saved && saved.accountId !== accountId) throw new SetupStop(`${statePath} is for account ${saved.accountId}, not ${accountId}.`);
  if (!accounts.some((a) => a.id === accountId)) throw new SetupStop(`Your Wrangler login cannot use account ${accountId}.`);

  const login = json<{ token?: string }>(await must(p, wrangler, ["auth", "token", "--json"], { cwd: workerDir, capture: true }, "Reading the Wrangler login"), "the Wrangler login");
  if (!login.token) throw new SetupStop("Wrangler returned no login token. Run `npx wrangler login` in cloud/worker, then rerun.");
  const cf = cfTransport(p.fetch, login.token);

  const tracked = (await import("../update/merge-wrangler.ts")).parseJsonc(readFileSync(join(workerDir, "wrangler.jsonc"), "utf8"), "cloud/worker/wrangler.jsonc");
  if (o.name && saved?.workerName && o.name !== saved.workerName) throw new SetupStop(`${statePath} is for the Worker ${saved.workerName}, not ${o.name}.`);
  const workerName = o.name ?? (saved?.workerName || (tracked.name as string));
  // A Worker of another name gets its own database and queue, never the default deployment's.
  const isolated = workerName !== tracked.name;
  const trackedDb = (tracked.d1_databases as { database_name: string }[])[0]!;
  const dbName = isolated ? workerName : trackedDb.database_name;
  const trackedQueue = (tracked.queues as { producers: { queue: string }[] }).producers[0]!.queue;

  // Read what is there. Nothing below this block writes until every check has passed.
  const sub = await account.workersSubdomain(cf, accountId).catch((e: unknown) => {
    if (e instanceof CfApiError && e.kind === "not_found") throw new SetupStop("This account has no workers.dev subdomain yet. Open Workers & Pages in the dashboard once to pick one, then rerun.");
    throw e;
  });
  const workerUrl = `https://${workerName}.${sub.subdomain}.workers.dev`;
  const bindings = await account.scriptBindings(cf, accountId, workerName);
  const dbBinding = binding(bindings, "d1", "DB");
  const pushBinding = binding(bindings, "queue", "PUSH_QUEUE");
  if (bindings && (!dbBinding || !pushBinding)) throw new SetupStop(`A Worker named ${workerName} exists and is not a yaran control plane. Pass --name to pick another name.`);
  // Fails closed: an existing Worker whose secret names cannot be read stops the run here.
  const secretNames = bindings ? await account.secretNames(cf, accountId, workerName) : new Set<string>();
  for (const b of bindings ?? []) if (b.type === "secret_text") secretNames.add(b.name);
  const dbId = dbBinding ? (dbBinding.id ?? dbBinding.database_id)! : ((await account.findDatabase(cf, accountId, dbName))?.uuid ?? null);
  const queue = pushBinding?.queue_name ?? (isolated ? `${workerName}-push` : trackedQueue);
  const queueExists = await account.queueExists(cf, accountId, queue);
  if (!bindings && !saved) {
    const other = (what: string) =>
      new SetupStop(`${what} already exists, but no Worker named ${workerName} uses it and no recovery file says this installer made it, so it may belong to another deployment. Pass --name to give this control plane its own Worker, database and queue, or delete it if it is a leftover.`);
    if (dbId) throw other(`The D1 database ${dbName}`);
    if (queueExists) throw other(`The queue ${queue}`);
  }
  const record = dbId ? await account.setupRecord(cf, accountId, dbId) : null;
  if (record?.cp_host && record.cp_host !== host) throw new SetupStop(`This control plane is being set up for ${record.cp_host}. Rerun with the matching --domain and --label.`);
  if (record?.step === "closed") {
    p.log(`Setup is already closed: https://${host} is live. Nothing to do; updates go through the update job.`);
    return { kind: "already_closed", host };
  }
  const recorded = record?.admin_email?.toLowerCase();
  if (o.adminEmail && recorded && o.adminEmail.trim().toLowerCase() !== recorded)
    throw new SetupStop(`Setup already names ${recorded} as the first admin, and a resume cannot change it. Rerun without --admin-email, or with --admin-email ${recorded}.`);
  const adminEmail = (o.adminEmail ?? recorded ?? (saved?.adminEmail || me.email) ?? "").trim().toLowerCase();
  if (!EMAIL.test(adminEmail)) throw new SetupStop("Pass --admin-email: the address you sign in with, which becomes the first admin.");

  const zone = await account.findZone(cf, accountId, domain);
  if (!zone) throw new SetupStop(`${domain} is not a zone in account ${accountId}. Add it to Cloudflare first, or pass the right --domain.`);
  const existingCallbacks = binding(bindings, "plain_text", "APP_CALLBACK_URLS")?.text;
  const callbacks = (o.appCallback ?? existingCallbacks ?? publisherCallbacks(join(o.repoRoot, "publisher.json")) ?? "").trim();
  if (!callbacks)
    throw new SetupStop(
      "Pass --app-callback with the phone app's https sign-in callback URL, for example https://<publisher-domain>/auth/callback. A release names it as APP_CALLBACK_URLS in the wrangler.jsonc of its cloud-deploy branch.",
    );
  for (const u of callbacks.split(/\s+/)) if (!/^https:\/\/[^\s/]+\/\S*$/.test(u)) throw new SetupStop(`--app-callback ${u} is not an https URL.`);

  const tokenStored = record !== null && record.step !== "locked" && record.step !== "token";
  let runtimeToken: string | null = null;
  if (o.newToken && tokenStored) p.log("The control plane already keeps its own copy of the API token; replace it on the console's Health page instead.");
  if (!tokenStored && (o.newToken || !secretNames.has("CF_API_TOKEN"))) {
    p.log(`The control plane needs its own Cloudflare API token. Create it from ${tokenTemplateUrl()}\nwith the two zone rows limited to ${domain}.`);
    runtimeToken = await p.readToken();
    if (!runtimeToken)
      throw new SetupStop(`The control plane needs its own Cloudflare API token: your Wrangler login cannot grant Access, DNS or Tunnel rights. ${tokenAdvice(domain)}`);
    await checkRuntimeToken(p, runtimeToken, accountId, workerName, bindings !== null, zone, label, domain, record?.step);
  }

  // Writes start here. The recovery file comes first, so a crash never loses a key.
  const setupCode = saved?.setupCode ?? newSetupCode();
  if (!saved?.setupCode && secretNames.has("SETUP_CODE")) p.log("Replacing the Worker's SETUP_CODE: no saved copy exists, and it only unlocks setup.");
  const keepRemoteKey = secretNames.has("DATA_KEY");
  if (keepRemoteKey && !saved?.dataKey) p.log("Keeping the Worker's existing DATA_KEY. This installer never saw it, so keep your own copy.");
  const dataKey = saved?.dataKey ?? (keepRemoteKey ? null : newDataKey());
  const state: OrgState = { version: 1, accountId, workerName, hostname: host, workerUrl, adminEmail, setupCode, dataKey, createdAt: saved?.createdAt || p.now().toISOString() };
  writeState(statePath, state, own);
  p.log(`Recovery file: ${statePath}`);

  let db = dbId ? await account.getDatabase(cf, accountId, dbId) : null;
  if (!db) {
    db = await account.createDatabase(cf, accountId, dbName);
    p.log(`Created D1 database ${db.name}.`);
  }
  if (!queueExists) {
    await account.createQueue(cf, accountId, queue);
    p.log(`Created queue ${queue}.`);
  }

  const configPath = join(workerDir, ".wrangler/yaran-org", `wrangler.${workerName}.json`);
  writeConfig(configPath, workerDir, tracked, { workerName, dbName: db.name, dbId: db.uuid, queue, callbacks });
  const env = { CLOUDFLARE_ACCOUNT_ID: accountId };
  await must(p, process.execPath, ["scripts/copy-ui-kit-assets.ts"], { cwd: workerDir }, "Copying the console assets");
  await must(p, join(workerDir, "node_modules/.bin/tsc"), ["-p", "tsconfig.assets.json"], { cwd: workerDir }, "Building the console script");
  await must(p, wrangler, ["d1", "migrations", "apply", "DB", "--remote", "--config", configPath], { cwd: workerDir, env }, "Applying the D1 migrations");
  await must(p, wrangler, ["deploy", "--config", configPath], { cwd: workerDir, env }, "Deploying the Worker");

  await account.putSecret(cf, accountId, workerName, "SETUP_CODE", setupCode);
  let keyUploaded = false;
  if (dataKey && !keepRemoteKey) {
    // Read again right before the one upload that cannot be undone: a key set since the start wins.
    if ((await account.secretNames(cf, accountId, workerName)).has("DATA_KEY")) {
      p.log("A DATA_KEY appeared on the Worker during this run. Keeping it; this installer never saw it, so keep your own copy.");
      if (!saved?.dataKey) writeState(statePath, { ...state, dataKey: null }, own);
    } else {
      await account.putSecret(cf, accountId, workerName, "DATA_KEY", dataKey);
      keyUploaded = true;
    }
  }
  if (runtimeToken) await account.putSecret(cf, accountId, workerName, "CF_API_TOKEN", runtimeToken);
  p.log("Secrets are set on the Worker.");
  const codeJustSet = !saved?.setupCode;
  if (codeJustSet || keyUploaded || runtimeToken) {
    p.log(`Waiting ${SECRET_SETTLE_MS / 1000}s for the new secrets to reach every Cloudflare location.`);
    await p.sleep(SECRET_SETTLE_MS);
  }

  await waitFor(p, `${workerUrl}/v1/meta`, () => true, 120_000, `${workerUrl} did not answer within two minutes. ${RESUME}`);
  const out = await (p.wizard ?? driveWizard)(
    { fetch: p.fetch, sleep: p.sleep, log: p.log },
    { origin: workerUrl, setupCode, accountId, adminEmail, zoneId: zone.id, zoneName: domain, label, team: o.team ?? domain.split(".")[0]!.replace(/[^a-z0-9-]/g, ""), addOneTimePin: !!o.oneTimePin, codeJustSet },
  );
  if (out.kind === "closed") return { kind: "already_closed", host };

  p.log(`\nLast step, a real sign-in: open this link and sign in through Access as ${adminEmail}. It works once, for 30 minutes:\n${out.link}\n`);
  p.openUrl(out.link);
  const closed = await waitFor(p, `https://${host}/v1/meta`, (m) => m.setup === "closed", o.claimWaitMs ?? 15 * 60_000, null);
  if (!closed) return { kind: "claim_pending", host, link: out.link };
  p.log(`Setup is closed. https://${host} is your control plane and ${adminEmail} its first admin.`);
  return { kind: "claimed", host };
}

/** The Worker's own probe and zone checks, run here so a bad token stops before any write. */
async function checkRuntimeToken(
  p: SetupPorts,
  token: string,
  accountId: string,
  script: string,
  workerExists: boolean,
  zone: { id: string; name: string },
  label: string,
  domain: string,
  step: string | undefined,
): Promise<void> {
  const rt = cfTransport(p.fetch, token);
  let acct = await resolveAccount(rt, undefined);
  if (!acct.ok && acct.reason !== "unverified") acct = await resolveAccount(rt, accountId);
  if (!acct.ok || acct.id !== accountId) throw new SetupStop(`That API token does not belong to account ${accountId}. ${tokenAdvice(domain)}`);
  // The script probe needs the Worker to exist; the Worker's own token step re-runs it.
  const rows = await probeCapabilities(rt, accountId, script, workerExists ? PERMISSIONS : PERMISSIONS.filter((r) => r.probe !== "worker_script"));
  if (!probePassed(rows)) {
    const missing = rows.filter((r) => r.outcome !== "ok").map((r) => `${r.permission.name}${r.outcome === "unchecked" ? " (could not be checked)" : ""}`);
    throw new SetupStop(`That API token lacks: ${missing.join("; ")}. ${tokenAdvice(domain)}`);
  }
  if (!(await listZones(rt)).some((z) => z.id === zone.id)) throw new SetupStop(`That API token cannot see ${domain}. ${tokenAdvice(domain)}`);
  if (step === undefined || step === "locked" || step === "token" || step === "org" || step === "zone") {
    const pick = await chooseHostname(rt, accountId, zone.id, label);
    if (!pick.ok && pick.problem === "hostname_conflict") throw new SetupStop(`${label}.${domain} already has a DNS record or Worker custom domain. Remove it or pass another --label.`);
  }
  const usable = await listIdps(rt, accountId).then(usableIdps, () => null);
  if (usable?.length === 0) p.log("Zero Trust has no sign-in method besides Cloudflare account login yet; the sign-in step will need one (see --one-time-pin).");
}

interface GeneratedConfig {
  workerName: string;
  dbName: string;
  dbId: string;
  queue: string;
  callbacks: string;
}

/** The tracked config with this org's values; paths stay relative to the generated file. */
export function writeConfig(path: string, workerDir: string, tracked: Record<string, unknown>, g: GeneratedConfig): void {
  const up = relative(dirname(path), workerDir) || ".";
  const db = (tracked.d1_databases as Record<string, unknown>[])[0]!;
  const queues = tracked.queues as { producers: Record<string, unknown>[]; consumers: Record<string, unknown>[] };
  const config = {
    ...tracked,
    name: g.workerName,
    main: join(up, tracked.main as string),
    assets: { ...(tracked.assets as Record<string, unknown>), directory: join(up, (tracked.assets as { directory: string }).directory) },
    d1_databases: [{ ...db, database_name: g.dbName, database_id: g.dbId, migrations_dir: join(up, db.migrations_dir as string) }],
    queues: { producers: queues.producers.map((q) => ({ ...q, queue: g.queue })), consumers: queues.consumers.map((q) => ({ ...q, queue: g.queue })) },
    vars: { ...(tracked.vars as Record<string, unknown>), APP_CALLBACK_URLS: g.callbacks },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** Polls a `/v1/meta` URL until `done` holds; bounded, network errors count as not yet. */
async function waitFor(p: SetupPorts, url: string, done: (meta: { setup?: string }) => boolean, limitMs: number, failure: string | null): Promise<boolean> {
  for (let waited = 0; waited <= limitMs; waited += 5000) {
    try {
      const r = await p.fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (r.ok && done((await r.json()) as { setup?: string })) return true;
    } catch {
      // DNS and certificates for a new hostname take a while; keep polling.
    }
    await p.sleep(5000);
  }
  if (failure) throw new SetupStop(failure);
  return false;
}
