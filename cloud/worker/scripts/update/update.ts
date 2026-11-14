/**
 * `npm run update`: updates this deploy repository to a newer yaran-cloud release on a branch.
 *
 * fetch-release (resolve, download, verify checksum and, with `--attest`, provenance) →
 * apply-update (replace upstream-owned files) → merge-wrangler (keep your values) → commit
 * on `yaran-cloud-update/v<version>` with a pull-request body listing what was preserved.
 * The workflow pushes the branch and opens the pull request; by hand you push and merge.
 *
 * Usage: node scripts/update/update.ts [--version X.Y.Z] [--attest] [--github-output <file>]
 *
 * <module-headers:begin>
 * Uses:
 * scripts/update/update.ts
 * ├── scripts/update/apply-update.ts
 * ├── scripts/update/fetch-release.ts
 * └── scripts/update/merge-wrangler.ts
 * External: node:child_process, node:fs, node:os, node:path, node:url, node:util
 *
 * Used by: entry point (CLI: npm run update in the deploy tree, and its yaran-cloud-update workflow)
 * scripts/update/update.ts
 * └── test/update-job.test.ts
 * <module-headers:end>
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { applyUpdate } from "./apply-update.ts";
import { checkStartingPoint, downloadVerified, extractVerified, resolveRelease, UpdateRefused } from "./fetch-release.ts";
import { controlPlaneSetupClosed, mergeWrangler } from "./merge-wrangler.ts";

export const TEMPLATE_COPY = ".yaran/wrangler.template.jsonc";

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);

export async function runUpdate(opts: { repo: string; version?: string; attest: boolean; fetcher?: typeof fetch; controlPlaneUrl?: string }) {
  const fetcher = opts.fetcher ?? fetch;
  const current = (JSON.parse(read(join(opts.repo, "release.json")) ?? "{}") as { version?: string }).version;
  if (!current) throw new UpdateRefused("release.json is missing, so the running version is unknown");
  const manifest = await resolveRelease(fetcher, opts.version || undefined);
  if (checkStartingPoint(current, manifest) === "up_to_date") return null;
  const tree = extractVerified(await downloadVerified(fetcher, manifest), opts.attest);
  const previousTemplate = read(join(opts.repo, TEMPLATE_COPY));
  const applied = applyUpdate(tree, opts.repo);
  const setupClosed = await controlPlaneSetupClosed(opts.controlPlaneUrl, fetcher);
  const merged = mergeWrangler({
    current: read(join(opts.repo, "wrangler.jsonc")) ?? read(join(tree, "wrangler.jsonc"))!,
    template: read(join(tree, TEMPLATE_COPY))!,
    previousTemplate,
    setupClosed: setupClosed === true,
  });
  writeFileSync(join(opts.repo, "wrangler.jsonc"), merged.text);
  writeFileSync(join(opts.repo, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const title = `Update yaran control plane to v${manifest.version}`;
  const body = [
    `Updates the yaran control plane from v${current} to v${manifest.version}.`,
    "",
    `- Release notes: ${manifest.notes_url}`,
    `- Security fix: ${manifest.security ? "**yes, merge soon**" : "no"}`,
    `- Tarball SHA-256 verified${opts.attest ? " and GitHub provenance attestation verified" : "; provenance not verified (no gh attestation in this run)"}.`,
    `- Files replaced: ${applied.written.length}; removed: ${applied.removed.length ? applied.removed.join(", ") : "none"}.`,
    `- Wrangler values kept: ${merged.preserved.length ? merged.preserved.join(", ") : "none"}.`,
    `- Keys this release does not know, kept as they were: ${merged.unknown.length ? merged.unknown.join(", ") : "none"}.`,
    setupClosed === null
      ? "- workers_dev: unchanged, because the YARAN_CONTROL_PLANE_URL variable is not set. Set it to your control-plane URL so the next update turns workers.dev off."
      : `- workers_dev: ${setupClosed ? "set to false, because your control plane reports setup closed" : "unchanged, because your control plane does not report setup closed yet"}.`,
    "",
    "Merging deploys the update; the deploy script applies database migrations first.",
  ].join("\n");
  const branch = `yaran-cloud-update/v${manifest.version}`;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: opts.repo, stdio: "inherit" });
  git("checkout", "-B", branch);
  git("add", "-A");
  git("commit", "-m", title);
  const bodyFile = join(tmpdir(), `yaran-update-${manifest.version}.md`);
  writeFileSync(bodyFile, body);
  return { branch, title, bodyFile, body };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { version: { type: "string" }, attest: { type: "boolean" }, "github-output": { type: "string" } } });
  try {
    const out = await runUpdate({ repo: process.cwd(), attest: !!values.attest, ...(values.version ? { version: values.version } : {}), ...(process.env.YARAN_CONTROL_PLANE_URL ? { controlPlaneUrl: process.env.YARAN_CONTROL_PLANE_URL } : {}) });
    if (!out) console.log("Already on the newest yaran-cloud release; nothing to do.");
    else console.log(`Committed ${out.title} on ${out.branch}. Push it and open a pull request:\n\n${out.body}`);
    if (values["github-output"]) {
      appendFileSync(values["github-output"], out ? `branch=${out.branch}\ntitle=${out.title}\nbody_file=${out.bodyFile}\n` : "branch=\n");
    }
  } catch (e) {
    console.error(e instanceof UpdateRefused ? `Update refused: ${e.message}` : e);
    process.exit(1);
  }
}
