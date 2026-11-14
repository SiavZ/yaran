/**
 * Agent routes the machine window may open: the restricted `store.ts` parseRoute grammar.
 *
 * `#/agent/<seg>` with an optional `/tab/<seg>`. A raw segment is one or more of
 * `[A-Za-z0-9-_.!~*'()]` or `%XX`; decoded, it must be 1-128 printable ASCII bytes (YaranId).
 * The Kotlin and Swift `RouteFragment` twins enforce the same rule against `fixtures/routes.json`.
 *
 * - Pure. `agentRoute` builds with `encodeURIComponent`, whose output always passes `isAgentRoute`.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/routes.ts
 * ├── src/index.ts
 * ├── src/openMachine.ts
 * └── test/routes.test.ts
 * <module-headers:end>
 */

const ROUTE_RE = /^#\/agent\/((?:[A-Za-z0-9\-_.!~*'()]|%[0-9A-Fa-f]{2})+)(?:\/tab\/((?:[A-Za-z0-9\-_.!~*'()]|%[0-9A-Fa-f]{2})+))?$/;
const ID_RE = /^[\x20-\x7e]{1,128}$/;

function segmentOk(raw: string): boolean {
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "%") {
      bytes.push(parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(raw.charCodeAt(i));
    }
  }
  return ID_RE.test(String.fromCharCode(...bytes));
}

export function isAgentRoute(route: string): boolean {
  const m = ROUTE_RE.exec(route);
  if (!m) return false;
  return segmentOk(m[1]!) && (m[2] === undefined || segmentOk(m[2]));
}

/** Builds `#/agent/<sid>[/tab/<tabId>]`; throws when an id is not a YaranId. */
export function agentRoute(sid: string, tabId?: string): string {
  const route = `#/agent/${encodeURIComponent(sid)}${tabId === undefined ? "" : `/tab/${encodeURIComponent(tabId)}`}`;
  if (!isAgentRoute(route)) throw new Error("agent and tab ids must be 1-128 printable ASCII characters");
  return route;
}
