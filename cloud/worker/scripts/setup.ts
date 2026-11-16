/**
 * The org installer, from a source checkout:
 *
 *   node cloud/worker/scripts/setup.ts --domain example.org [--label cp]
 *
 * Takes a Cloudflare account with a Wrangler login to a deployed control plane waiting only
 * for the first admin's Access sign-in; rerun the same command to resume. The work is in
 * `org-setup/run.ts`; this file wires it to the real process, network and terminal.
 *
 * - The runtime API token, when one is needed, is read without echo (or from stdin when
 *   piped); it is never an argument or an environment variable.
 * - Only Node built-ins are imported up front: the npm trees are installed by the run.
 *
 * <module-headers:begin>
 * Uses:
 * scripts/setup.ts
 * └── scripts/org-setup/run.ts
 * External: node:child_process, node:fs, node:path, node:url, node:util
 *
 * Used by: entry point (CLI: node cloud/worker/scripts/setup.ts, the org installer from a source checkout)
 * <module-headers:end>
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runSetup, SetupStop, type Runner } from "./org-setup/run.ts";

const USAGE = `Usage: node cloud/worker/scripts/setup.ts --domain <zone> [options]

  --domain <zone>         Your Cloudflare zone, for example example.org (required)
  --label <label>         The control plane answers at <label>.<zone> (default cp)
  --admin-email <email>   The first admin (default: your Wrangler login's email)
  --app-callback <url>    The phone app's https sign-in callback (a new Worker needs it
                          unless publisher.json names the publisher domain)
  --account-id <id>       Only when your login sees several accounts
  --name <worker>         Worker name (default yaran-cloud); another name also gets its
                          own D1 database (<worker>) and queue (<worker>-push)
  --team <name>           Zero Trust team name if one must be created (default: the zone's first label)
  --token                 Supply a new runtime API token (asked without echo, or read from stdin)
  --one-time-pin          Add One-time PIN if Zero Trust has no other sign-in method
  --state-file <path>     Recovery file (default ~/.yaran/cloud-setup/<host>.json on macOS)
`;

const run: Runner = (cmd, args, o) =>
  new Promise((done) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ["ignore", o.capture ? "pipe" : "inherit", "inherit"] });
    let stdout = "";
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    child.on("error", () => done({ code: 127, stdout }));
    child.on("close", (code) => done({ code: code ?? 1, stdout }));
  });

async function readHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  try {
    for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return value.trim();
        if (ch === "\u0003") throw new SetupStop("Cancelled.");
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    }
    return value.trim();
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\n");
  }
}

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) text += chunk.toString("utf8");
  return text.trim();
}

const OPTIONS = {

  domain: { type: "string" },
  label: { type: "string" },
  "admin-email": { type: "string" },
  "app-callback": { type: "string" },
  "account-id": { type: "string" },
  name: { type: "string" },
  team: { type: "string" },
  token: { type: "boolean" },
  "one-time-pin": { type: "boolean" },
  "state-file": { type: "string" },
  help: { type: "boolean" },
} as const;
const f = (() => {
  try {
    return parseArgs({ options: OPTIONS }).values;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return process.exit(2);
  }
})();
if (f.help || !f.domain) {
  process.stdout.write(USAGE);
  process.exit(f.help ? 0 : 2);
}

// A signal ends the run through process.exit, which releases the recovery file's lock.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => process.exit(signal === "SIGINT" ? 130 : 143));

try {
  const result = await runSetup(
    {
      run,
      fetch: (input, init) => fetch(input, init),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: (line) => console.log(line),
      exists: existsSync,
      readToken: async () => {
        if (process.stdin.isTTY) return (await readHidden("Paste the control plane's Cloudflare API token (not shown): ")) || null;
        return f.token ? (await readStdin()) || null : null;
      },
      openUrl: (url) => {
        const opener = process.platform === "darwin" ? "open" : "xdg-open";
        spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
      },
      now: () => new Date(),
    },
    {
      repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      domain: f.domain,
      label: f.label,
      adminEmail: f["admin-email"],
      appCallback: f["app-callback"],
      accountId: f["account-id"],
      name: f.name,
      team: f.team,
      newToken: f.token,
      oneTimePin: f["one-time-pin"],
      stateFile: f["state-file"],
    },
  );
  if (result.kind === "claim_pending") console.log("Not claimed yet. The link above stays valid for 30 minutes; rerun the same command for a new one.");
} catch (e) {
  // Messages name endpoints and steps, never a secret; a stack trace helps nobody here.
  console.error(`\n${e instanceof SetupStop ? e.message : `${e instanceof Error ? e.message : String(e)}\nRerun the same command to resume.`}`);
  process.exit(1);
}
