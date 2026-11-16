/**
 * Carries the deployer's Wrangler values onto a new release's template, keeping its comments.
 *
 * Deployer-owned: `name`, `account_id`, each D1 binding's `database_id`/`database_name`,
 * `routes`, `vars` they changed or added, and any key the template does not know (kept and
 * listed). `APP_CALLBACK_URLS` is upstream-owned: the new release's value wins unless the
 * deployer's differs from the previous release's default, in which case theirs is kept and
 * listed. It never adds a route or custom domain of its own, never sets `preview_urls: true`,
 * and sets `workers_dev: false` once the control plane reports setup closed.
 *
 * - Pure text in, text out (jsonc-parser edits), so comments in the template survive.
 *
 * <module-headers:begin>
 * Uses: none
 * External: jsonc-parser
 *
 * Used by:
 * scripts/update/merge-wrangler.ts
 * ├── scripts/update/update.ts
 * ├── test/node/deploy-tree.test.ts
 * └── test/node/update-job.test.ts
 * <module-headers:end>
 */
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

type Json = Record<string, unknown>;

export interface MergeInput {
  current: string;
  template: string;
  /** The previous release's pristine template, for the APP_CALLBACK_URLS rule. */
  previousTemplate: string | null;
  setupClosed: boolean;
}

export interface MergeResult {
  text: string;
  preserved: string[];
  unknown: string[];
}

const FMT = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
const UPSTREAM_VARS = new Set(["APP_CALLBACK_URLS"]);

export function parseJsonc(text: string, what: string): Json {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || typeof value !== "object" || value === null) throw new Error(`${what} is not valid JSONC`);
  return value as Json;
}

export function mergeWrangler(input: MergeInput): MergeResult {
  const cur = parseJsonc(input.current, "the current wrangler.jsonc");
  const tpl = parseJsonc(input.template, "the release's wrangler template");
  const prev = input.previousTemplate ? parseJsonc(input.previousTemplate, "the previous release's template") : null;
  let text = input.template;
  const preserved: string[] = [];
  const unknown: string[] = [];
  const set = (path: (string | number)[], value: unknown) => {
    text = applyEdits(text, modify(text, path, value, FMT));
  };

  for (const key of ["name", "account_id"] as const) {
    if (cur[key] !== undefined && JSON.stringify(cur[key]) !== JSON.stringify(tpl[key])) {
      set([key], cur[key]);
      preserved.push(key);
    }
  }
  const curDbs = (cur.d1_databases ?? []) as Json[];
  ((tpl.d1_databases ?? []) as Json[]).forEach((db, i) => {
    const mine = curDbs.find((d) => d.binding === db.binding);
    for (const field of ["database_id", "database_name"] as const) {
      if (mine?.[field] !== undefined && mine[field] !== db[field]) {
        set(["d1_databases", i, field], mine[field]);
        preserved.push(`d1_databases.${String(db.binding)}.${field}`);
      }
    }
  });
  if (Array.isArray(cur.routes) && cur.routes.length > 0) {
    set(["routes"], cur.routes);
    preserved.push("routes");
  }

  const curVars = (cur.vars ?? {}) as Json;
  const tplVars = (tpl.vars ?? {}) as Json;
  const prevVars = (prev?.vars ?? {}) as Json;
  for (const [k, v] of Object.entries(curVars)) {
    if (UPSTREAM_VARS.has(k)) {
      if (prev && JSON.stringify(v) !== JSON.stringify(prevVars[k])) {
        set(["vars", k], v);
        preserved.push(`vars.${k}`);
      }
    } else if (!(k in tplVars)) {
      set(["vars", k], v);
      unknown.push(`vars.${k}`);
    } else if (JSON.stringify(v) !== JSON.stringify(tplVars[k])) {
      set(["vars", k], v);
      preserved.push(`vars.${k}`);
    }
  }

  for (const key of Object.keys(cur)) {
    if (!(key in tpl) && key !== "account_id") {
      set([key], cur[key]);
      unknown.push(key);
    }
  }
  if (input.setupClosed || cur.workers_dev === false) set(["workers_dev"], false);
  set(["preview_urls"], false);
  return { text, preserved, unknown };
}

/** True when the deployed control plane's public `/v1/meta` reports setup closed. */
export async function controlPlaneSetupClosed(url: string | undefined, fetcher: typeof fetch = fetch): Promise<boolean | null> {
  if (!url) return null;
  try {
    const res = await fetcher(new URL("/v1/meta", url), { headers: { Accept: "application/json" } });
    if (!res.ok) return false;
    return ((await res.json()) as { setup?: string }).setup === "closed";
  } catch {
    return false;
  }
}
