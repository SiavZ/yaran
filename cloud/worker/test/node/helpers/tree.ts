/**
 * Assembles a deploy tree into a temp directory with a stand-in ui-kit, offline (no lockfile).
 *
 * <module-headers:begin>
 * Uses:
 * test/node/helpers/tree.ts
 * └── scripts/assemble-deploy-tree.ts
 * External: node:fs, node:os, node:path, node:url
 *
 * Used by:
 * test/node/helpers/tree.ts
 * ├── test/node/deploy-tree.test.ts
 * └── test/node/update-job.test.ts
 * <module-headers:end>
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble } from "../../../scripts/assemble-deploy-tree.ts";

export const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function fakeUiKit(): { tokens: string; font: string } {
  const dir = mkdtempSync(join(tmpdir(), "uikit-"));
  writeFileSync(join(dir, "tokens.css"), ":root { --background: x; }\n");
  writeFileSync(join(dir, "f.woff2"), "font");
  return { tokens: join(dir, "tokens.css"), font: join(dir, "f.woff2") };
}

export function assembleAt(tag: string, out = mkdtempSync(join(tmpdir(), "tree-")), lockfile = false): string {
  return assemble({ workerDir: WORKER, protocolDir: join(WORKER, "../protocol"), out, tag, publisherDomain: "app.example.org", uiKit: fakeUiKit(), lockfile });
}
