/**
 * Replaces the upstream-owned files of a deploy repository with a new release's copies.
 *
 * The release tree's `upstream-files.json` lists every path yaran owns; those are copied
 * over, paths the previous release owned but the new one no longer ships are deleted, and
 * everything else in the repository (the deployer's own files and `wrangler.jsonc`, which
 * merge-wrangler handles) is left untouched.
 *
 * - Refuses any listed path that escapes the repository.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:fs, node:path
 *
 * Used by:
 * scripts/update/apply-update.ts
 * └── scripts/update/update.ts
 * <module-headers:end>
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

export const UPSTREAM_LIST = "upstream-files.json";

export function readUpstreamList(dir: string): string[] {
  const p = join(dir, UPSTREAM_LIST);
  if (!existsSync(p)) return [];
  const list = JSON.parse(readFileSync(p, "utf8")) as unknown;
  if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) throw new Error(`${p} is not a list of paths`);
  for (const rel of list) {
    const n = normalize(rel);
    if (n.startsWith("..") || n.startsWith(sep) || n === "wrangler.jsonc") throw new Error(`refusing upstream path ${rel}`);
  }
  return list;
}

export interface ApplyResult {
  written: string[];
  removed: string[];
}

export function applyUpdate(newTree: string, repo: string): ApplyResult {
  const next = readUpstreamList(newTree);
  if (next.length === 0) throw new Error(`the release tree has no ${UPSTREAM_LIST}`);
  const prev = readUpstreamList(repo);
  const keep = new Set(next);
  const removed = prev.filter((p) => !keep.has(p) && existsSync(join(repo, p)));
  for (const rel of removed) rmSync(join(repo, rel), { force: true });
  for (const rel of [...next, UPSTREAM_LIST]) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    cpSync(join(newTree, rel), join(repo, rel));
  }
  return { written: next, removed };
}
