/**
 * Builds the self-contained deploy tree the Deploy to Cloudflare button clones (D18).
 *
 * On main the Worker imports `@yaran/protocol` from `cloud/protocol` and its tokens from
 * `packages/ui-kit`; the button needs a directory with no dependency outside it. This copies
 * the Worker's sources, compiles the protocol package into `vendor/cloud-protocol/`, copies
 * ui-kit's tokens and font, writes the deployer-facing files from `deploy-template/`
 * (with `APP_CALLBACK_URLS` from `publisher.json`), stamps the version, lists every
 * upstream-owned path in `upstream-files.json`, and regenerates the lockfile.
 *
 * Usage (Phase 18's release-cloud workflow):
 *   node scripts/assemble-deploy-tree.ts --out <dir> --tag yaran-cloud-vX.Y.Z --publisher publisher.json
 *   node scripts/assemble-deploy-tree.ts --write-manifest <dir>/worker --tag … --tarball-sha256 <hex> [--security] [--min-update-from X.Y.Z]
 * The manifest is a second step because a tarball cannot contain its own checksum.
 *
 * <module-headers:begin>
 * Uses:
 * scripts/assemble-deploy-tree.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── scripts/copy-ui-kit-assets.ts
 * ├── src/admin/wire-time.ts
 * └── src/update/release-manifest.ts
 * External: node:child_process, node:fs, node:path, node:url, node:util
 *
 * Used by: entry point (CLI: npm run assemble-deploy-tree, run by Phase 18's release-cloud workflow)
 * scripts/assemble-deploy-tree.ts
 * ├── test/node/deploy-tree.test.ts
 * ├── test/node/helpers/tree.ts
 * └── test/node/update-job.test.ts
 * <module-headers:end>
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PROTOCOL_MAX, PROTOCOL_MIN, type ReleaseManifest } from "@yaran/protocol";
import { wireTime } from "../src/admin/wire-time.ts";
import { parseManifest, REPO, TRAIN_TAG_PREFIX } from "../src/update/release-manifest.ts";
import { copyUiKitAssets, defaultSources, type CopySources } from "./copy-ui-kit-assets.ts";

const TAG = /^yaran-cloud-v(\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,32})?)$/;
/** Copied from the Worker as they are. */
const WORKER_PATHS = ["src", "migrations", "assets", "tsconfig.json", "tsconfig.assets.json", "scripts/permissions.json", "scripts/token-url.ts", "scripts/update"];
const TEMPLATE_FILES: [string, string][] = [
  ["README.md", "README.md"],
  [".dev.vars.example", ".dev.vars.example"],
  [".gitlab-ci.yml", ".gitlab-ci.yml"],
  [".github/workflows/yaran-cloud-update.yml", ".github/workflows/yaran-cloud-update.yml"],
];
const BUILD_OUTPUTS = new Set(["assets/console/enhance.js"]);

export interface AssembleOptions {
  workerDir: string;
  protocolDir: string;
  out: string;
  tag: string;
  publisherDomain: string;
  uiKit: CopySources;
  /** Regenerate package-lock.json (needs the npm registry). */
  lockfile: boolean;
}

export function versionOf(tag: string): string {
  const m = TAG.exec(tag);
  if (!m) throw new Error(`not a yaran-cloud tag: ${tag}`);
  return m[1]!;
}

/** `APP_CALLBACK_URLS` from publisher.json's domain (18's one home for it). */
export function callbackUrls(publisherDomain: string): string {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(publisherDomain)) throw new Error(`publisher_domain is not a hostname: ${publisherDomain}`);
  return `https://${publisherDomain}/auth/callback`;
}

function filesUnder(root: string, dir = root): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(root, p) : [relative(root, p)];
  });
}

/** Compiles cloud/protocol to JS + .d.ts; the JSON schemas and registries it imports come along. */
function vendorProtocol(protocolDir: string, dest: string, workerDir: string): void {
  mkdirSync(dest, { recursive: true });
  const config = join(dest, "tsconfig.vendor.json");
  writeFileSync(
    config,
    JSON.stringify({
      extends: join(protocolDir, "tsconfig.json"),
      compilerOptions: { noEmit: false, declaration: true, types: [], rewriteRelativeImportExtensions: true, rootDir: protocolDir, outDir: join(dest, "dist") },
      files: [join(protocolDir, "src/index.ts")],
      include: [],
    }),
  );
  execFileSync(process.execPath, [join(workerDir, "node_modules/typescript/bin/tsc"), "-p", config], { stdio: "inherit" });
  rmSync(config);
  // The Worker imports registries by subpath (`@yaran/protocol/registry/<name>.json`), which tsc does not emit.
  cpSync(join(protocolDir, "registry"), join(dest, "registry"), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(protocolDir, "package.json"), "utf8")) as { name: string; version: string; license: string; dependencies: Record<string, string> };
  const vendored = {
    name: pkg.name,
    version: pkg.version,
    private: true,
    description: "Bundled copy of the yaran cloud wire contract, generated for the deploy tree. Do not edit.",
    license: pkg.license,
    type: "module",
    exports: { ".": { types: "./dist/src/index.d.ts", default: "./dist/src/index.js" }, "./registry/*": "./registry/*" },
    dependencies: pkg.dependencies,
  };
  writeFileSync(join(dest, "package.json"), `${JSON.stringify(vendored, null, 2)}\n`);
}

function treePackageJson(workerDir: string): string {
  const pkg = JSON.parse(readFileSync(join(workerDir, "package.json"), "utf8")) as Record<string, unknown> & { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  pkg.description = "The yaran org control plane on Cloudflare Workers.";
  pkg.dependencies = { ...pkg.dependencies, "@yaran/protocol": "file:vendor/cloud-protocol" };
  const { vitest: _v, "@types/node": _t, ...dev } = pkg.devDependencies;
  pkg.devDependencies = dev;
  pkg.scripts = {
    build: "tsc -p tsconfig.assets.json",
    deploy: "npm run db:migrations:apply && wrangler deploy",
    "db:migrations:apply": "wrangler d1 migrations apply DB --remote",
    "token-url": "node scripts/token-url.ts",
    update: "node scripts/update/update.ts",
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export function assemble(o: AssembleOptions): string {
  const version = versionOf(o.tag);
  const tree = resolve(o.out, "worker");
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  for (const p of WORKER_PATHS) {
    const from = join(o.workerDir, p);
    if (existsSync(from)) cpSync(from, join(tree, p), { recursive: true, filter: (src) => !BUILD_OUTPUTS.has(relative(o.workerDir, src)) });
  }
  copyUiKitAssets(o.uiKit, join(tree, "assets"));
  vendorProtocol(o.protocolDir, join(tree, "vendor/cloud-protocol"), o.workerDir);
  writeFileSync(join(tree, "src/update/worker-version.ts"), readFileSync(join(o.workerDir, "src/update/worker-version.ts"), "utf8").replace(/"0\.0\.0-dev"/, JSON.stringify(version)));
  for (const [from, to] of TEMPLATE_FILES) {
    mkdirSync(dirname(join(tree, to)), { recursive: true });
    cpSync(join(o.workerDir, "deploy-template", from), join(tree, to));
  }
  const wrangler = readFileSync(join(o.workerDir, "deploy-template/wrangler.template.jsonc"), "utf8").replace('"__APP_CALLBACK_URLS__"', JSON.stringify(callbackUrls(o.publisherDomain)));
  writeFileSync(join(tree, "wrangler.jsonc"), wrangler);
  mkdirSync(join(tree, ".yaran"), { recursive: true });
  writeFileSync(join(tree, ".yaran/wrangler.template.jsonc"), wrangler);
  writeFileSync(join(tree, ".gitignore"), "node_modules/\n.wrangler/\n.dev.vars\ndist/\nassets/console/enhance.js\n");
  writeFileSync(join(tree, "package.json"), treePackageJson(o.workerDir));
  if (o.lockfile) execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: tree, stdio: "inherit" });
  const upstream = filesUnder(tree).filter((p) => p !== "wrangler.jsonc" && p !== "upstream-files.json").sort();
  writeFileSync(join(tree, "upstream-files.json"), `${JSON.stringify(upstream, null, 2)}\n`);
  return tree;
}

/** Writes `release.json` into an assembled tree once the tarball's checksum is known. */
export function writeManifest(tree: string, tag: string, tarballSha256: string, opts: { security: boolean; minUpdateFrom?: string; now?: Date }): ReleaseManifest {
  const version = versionOf(tag);
  const manifest = {
    train: "yaran-cloud",
    version,
    tag,
    released_at: wireTime(opts.now ?? new Date()),
    protocol: { min: PROTOCOL_MIN, max: PROTOCOL_MAX },
    min_update_from: opts.minUpdateFrom ?? "0.0.0",
    security: opts.security,
    notes_url: `https://github.com/${REPO}/releases/tag/${tag}`,
    tarball: { url: `https://github.com/${REPO}/releases/download/${tag}/yaran-cloud-worker-v${version}.tar.gz`, sha256: tarballSha256 },
  };
  const parsed = parseManifest(manifest);
  if (!parsed.ok) throw new Error(`refusing to write an invalid release manifest: ${parsed.reason}`);
  writeFileSync(join(tree, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return parsed.manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      tag: { type: "string" },
      publisher: { type: "string" },
      "no-lockfile": { type: "boolean" },
      "write-manifest": { type: "string" },
      "tarball-sha256": { type: "string" },
      security: { type: "boolean" },
      "min-update-from": { type: "string" },
    },
  });
  const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = resolve(workerDir, "../..");
  if (!values.tag?.startsWith(TRAIN_TAG_PREFIX)) throw new Error("--tag yaran-cloud-vX.Y.Z is required");
  if (values["write-manifest"]) {
    if (!values["tarball-sha256"]) throw new Error("--tarball-sha256 is required with --write-manifest");
    const opts = { security: !!values.security, ...(values["min-update-from"] ? { minUpdateFrom: values["min-update-from"] } : {}) };
    writeManifest(values["write-manifest"], values.tag, values["tarball-sha256"], opts);
  } else {
    if (!values.out || !values.publisher) throw new Error("--out <dir> and --publisher <publisher.json> are required");
    const publisher = JSON.parse(readFileSync(values.publisher, "utf8")) as { publisher_domain: string };
    const tree = assemble({
      workerDir,
      protocolDir: join(repoRoot, "cloud/protocol"),
      out: values.out,
      tag: values.tag,
      publisherDomain: publisher.publisher_domain,
      uiKit: defaultSources(repoRoot),
      lockfile: !values["no-lockfile"],
    });
    console.log(`Assembled the deploy tree at ${tree}`);
  }
}
