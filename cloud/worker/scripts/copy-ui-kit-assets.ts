/**
 * Copies ui-kit's design tokens and the Geist variable font into the console's assets.
 *
 * `packages/ui-kit/src/tokens.css` (Phase 14) is the one token source for the web UI, the
 * app and this console, so the console never generates colours: this copies the file byte
 * for byte to `assets/console/tokens.css` (git-ignored on main, carried by the assembled
 * deploy tree) and the Geist woff2 (OFL-1.1) to `assets/console/fonts/`.
 *
 * - Run by `npm run build`. Fails loudly when a source is missing; never writes a placeholder.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:fs, node:path, node:url
 *
 * Used by:
 * scripts/copy-ui-kit-assets.ts
 * ├── scripts/assemble-deploy-tree.ts
 * └── test/ui-kit.test.tsx
 * <module-headers:end>
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FONT = "geist-latin-wght-normal.woff2";

export interface CopySources {
  tokens: string;
  font: string;
}

/** Where the sources live in the monorepo checkout. */
export function defaultSources(repoRoot: string): CopySources {
  const fontCandidates = [
    join(repoRoot, "packages/ui-kit/node_modules/@fontsource-variable/geist/files", FONT),
    join(repoRoot, "node_modules/@fontsource-variable/geist/files", FONT),
    join(repoRoot, "crates/yaran-web/web/node_modules/@fontsource-variable/geist/files", FONT),
  ];
  return {
    tokens: join(repoRoot, "packages/ui-kit/src/tokens.css"),
    font: fontCandidates.find((p) => existsSync(p)) ?? fontCandidates[0]!,
  };
}

export function copyUiKitAssets(sources: CopySources, assetsDir: string): void {
  for (const [what, path] of Object.entries(sources)) {
    if (!existsSync(path)) throw new Error(`ui-kit ${what} not found at ${path}; run npm ci in packages/ui-kit (Phase 14) first`);
  }
  mkdirSync(join(assetsDir, "console/fonts"), { recursive: true });
  copyFileSync(sources.tokens, join(assetsDir, "console/tokens.css"));
  copyFileSync(sources.font, join(assetsDir, "console/fonts", FONT));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  copyUiKitAssets(defaultSources(resolve(workerDir, "../..")), join(workerDir, "assets"));
}
