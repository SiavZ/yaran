/**
 * The app's URIs (Design §10): the add-org QR payload, the handoff callback parameters,
 * and the three in-WebView control URLs machine-view intercepts.
 *
 * Parsing rules, shared with the Rust builders and the native apps: the scheme compares
 * case-insensitively, the authority (plus any path) is the command, a duplicate parameter
 * makes the URI invalid, unknown parameters are ignored, and an unknown command is
 * uri_invalid and does nothing.
 *
 * - Trust boundary: every URI here may come from a QR code, another app or web content.
 * - Pure. Rust twin (builders only): `yaran_core::cloud::protocol::uri`.
 *
 * <module-headers:begin>
 * Uses:
 * src/uri.ts
 * External: (none)
 *
 * Used by:
 * src/uri.ts
 * ├── src/index.ts
 * └── test/uri.test.ts
 * <module-headers:end>
 */

export const ORG_URL_RE = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
export const ADD_ORG_MAX_CHARS = 512;

/** The add-org QR payload; throws when the org URL is not an OrgUrl or the URI is too long. */
export function addOrgUri(orgUrl: string): string {
  if (!ORG_URL_RE.test(orgUrl)) throw new Error("org url must be an https origin");
  const uri = `yaranapp://add-org?u=${encodeURIComponent(orgUrl)}`;
  if (uri.length > ADD_ORG_MAX_CHARS) throw new Error("add-org uri exceeds 512 characters");
  return uri;
}

/** In-WebView control URL builders (Phase 13's reauthUrl uses the first). */
export const reauthUri = (host: string) => `yaranapp://reauth?host=${encodeURIComponent(host)}`;
export const HOME_URI = "yaranapp://home";
export const SETTINGS_URI = "yaranapp://settings";

export interface ParsedUri {
  /** Lowercased scheme. */
  scheme: string;
  /** Authority plus path, e.g. "add-org", "auth/callback", "reauth". */
  command: string;
  query: Map<string, string>;
  fragment: Map<string, string>;
}

const URI_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?(?:\?([^#]*))?(?:#(.*))?$/;

function parseParams(text: string | undefined): Map<string, string> | null {
  const out = new Map<string, string>();
  if (!text) return out;
  for (const pair of text.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    const rawValue = eq < 0 ? "" : pair.slice(eq + 1);
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(rawKey);
      value = decodeURIComponent(rawValue);
    } catch {
      return null;
    }
    if (out.has(key)) return null;
    out.set(key, value);
  }
  return out;
}

/** Splits a URI into scheme, command and parameters; null when malformed or duplicated. */
export function parseUri(uri: string): ParsedUri | null {
  const m = URI_RE.exec(uri);
  if (!m) return null;
  const query = parseParams(m[4]);
  const fragment = parseParams(m[5]);
  if (!query || !fragment) return null;
  return { scheme: m[1]!.toLowerCase(), command: `${m[2]!}${m[3] ?? ""}`, query, fragment };
}

export type AppUri =
  | { ok: true; kind: "add-org"; orgUrl: string }
  | { ok: true; kind: "reauth"; host: string }
  | { ok: true; kind: "home" }
  | { ok: true; kind: "settings" }
  | { ok: false; code: "uri_invalid" };

/** Parses a `yaranapp:` URI the app may be handed (QR, deep link, machine-view intercept). */
export function parseAppUri(uri: string): AppUri {
  const invalid: AppUri = { ok: false, code: "uri_invalid" };
  if (uri.length > ADD_ORG_MAX_CHARS) return invalid;
  const p = parseUri(uri);
  if (!p || p.scheme !== "yaranapp") return invalid;
  switch (p.command) {
    case "add-org": {
      const u = p.query.get("u");
      return u !== undefined && ORG_URL_RE.test(u) ? { ok: true, kind: "add-org", orgUrl: u } : invalid;
    }
    case "reauth": {
      const host = p.query.get("host");
      return host !== undefined && HOSTNAME_RE.test(host) ? { ok: true, kind: "reauth", host } : invalid;
    }
    case "home":
      return { ok: true, kind: "home" };
    case "settings":
      return { ok: true, kind: "settings" };
    default:
      return invalid;
  }
}

export type ControlDecision = "reauth" | "home" | "settings" | "ignore";

/**
 * What machine-view does with a navigation to a control URL: reauth is honoured only for
 * the host currently loaded; anything invalid is ignored.
 */
export function controlUrlDecision(uri: string, loadedHost: string): ControlDecision {
  const parsed = parseAppUri(uri);
  if (!parsed.ok) return "ignore";
  switch (parsed.kind) {
    case "reauth":
      return parsed.host === loadedHost ? "reauth" : "ignore";
    case "home":
      return "home";
    case "settings":
      return "settings";
    case "add-org":
      return "ignore";
    default:
      return assertNever(parsed);
  }
}

/**
 * The handoff callback parameters of an https or dev callback URI (query, or fragment
 * when the query carries none). Returns null on a malformed or duplicated parameter.
 */
export function handoffCallbackParams(uri: string): Map<string, string> | null {
  const p = parseUri(uri);
  if (!p) return null;
  return p.query.size > 0 ? p.query : p.fragment;
}

function assertNever(value: never): never {
  throw new Error(`unhandled uri ${JSON.stringify(value)}`);
}
