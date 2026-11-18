/**
 * The app's URIs (Design §10): the add-org QR payload, the handoff callback parameters,
 * the three in-WebView control URLs machine-view intercepts, the add-machine QR payload
 * and the verified agent link (docs/operations/mobile-parity-contracts.md).
 *
 * Parsing rules, shared with the Rust builders and the native apps: the scheme compares
 * case-insensitively, the authority (plus any path) is the command, a duplicate parameter
 * makes the URI invalid, unknown parameters are ignored, and an unknown command is
 * uri_invalid and does nothing. The two newer forms are STRICT: any parameter they do not
 * name, an empty pair, a query or fragment they do not use, or a non-canonical value makes
 * them uri_invalid. They have parsers of their own, so `parseAppUri` (and every exhaustive
 * switch over `AppUri`) is unchanged and still answers uri_invalid for them.
 *
 * - Trust boundary: every URI here may come from a QR code, another app or web content.
 * - Pure. Rust twin (builders only): `yaran_core::cloud::protocol::uri`.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/uri.ts
 * ├── src/index.ts
 * ├── test/uri.test.ts
 * ├── web:src/components/LoginPage.tsx
 * ├── web:src/components/OfflineOverlay.tsx
 * ├── web:src/lib/appMenu.ts
 * ├── web:src/lib/phoneApi.ts
 * └── web:src/lib/phoneLink.ts
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

/** The Worker's machine id (common.schema.json `Uuid`); a copy, since this file imports nothing. */
const MACHINE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** An agent or tab id (common.schema.json `YaranId`). */
export const YARAN_ID_RE = /^[\x21-\x7e]{1,128}$/;
export const ADD_MACHINE_MAX_CHARS = 512;
export const AGENT_LINK_MAX_CHARS = 1024;

/**
 * True for a host the app may load or link to: lowercase, at least two labels, an
 * alphabetic TLD, no port, no IP literal and no IDN label (`HostRules.host` on native).
 */
export function isPublicHost(host: string): boolean {
  return (
    typeof host === "string" &&
    host.length <= 253 &&
    ORG_URL_RE.test(`https://${host}`) &&
    !host.split(".").some((label) => label.startsWith("xn--"))
  );
}

/**
 * Strict `k=v&k=v` reader: every pair has a non-empty key and an `=`, escapes are well
 * formed, keys are unique, and only `allowed` keys appear. Null on any violation.
 */
function strictParams(text: string, allowed: readonly string[]): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const pair of text.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return null;
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(pair.slice(0, eq));
      value = decodeURIComponent(pair.slice(eq + 1));
    } catch {
      return null;
    }
    if (!allowed.includes(key) || out.has(key)) return null;
    out.set(key, value);
  }
  return out;
}

/** The add-machine QR payload for a direct machine; throws when `host` is not a public host. */
export function addMachineUri(host: string): string {
  if (!isPublicHost(host)) throw new Error("machine host must be a lowercase DNS name with no port");
  const uri = `yaranapp://add-machine?u=${encodeURIComponent(`https://${host}`)}`;
  if (uri.length > ADD_MACHINE_MAX_CHARS) throw new Error("add-machine uri exceeds 512 characters");
  return uri;
}

export type AddMachineUri = { ok: true; kind: "add-machine"; host: string } | { ok: false; code: "uri_invalid" };

/**
 * Parses `yaranapp://add-machine?u=<https origin>`. Exactly one parameter, `u`, an https
 * origin on the default port with a public host; no path, fragment or other parameter.
 * The result only pre-fills the Confirm machine screen: it never adds anything by itself.
 */
export function parseAddMachineUri(uri: string): AddMachineUri {
  const invalid: AddMachineUri = { ok: false, code: "uri_invalid" };
  if (typeof uri !== "string" || uri.length > ADD_MACHINE_MAX_CHARS) return invalid;
  const m = URI_RE.exec(uri);
  if (!m || m[1]!.toLowerCase() !== "yaranapp" || m[2] !== "add-machine" || m[3] !== undefined) return invalid;
  if (m[4] === undefined || m[5] !== undefined || uri.includes("#")) return invalid;
  const q = strictParams(m[4], ["u"]);
  const u = q?.get("u");
  if (u === undefined || !u.startsWith("https://") || !isPublicHost(u.slice("https://".length))) return invalid;
  return { ok: true, kind: "add-machine", host: u.slice("https://".length) };
}

/** Which known machine an agent link names. Neither form carries a credential. */
export type AgentLinkTarget = { kind: "org"; orgUrl: string; machineId: string } | { kind: "direct"; host: string };

export interface AgentLink {
  target: AgentLinkTarget;
  agentId: string;
  /** Absent for the agent's slot tab. */
  tabId?: string;
}

export type ParsedAgentLink = ({ ok: true } & AgentLink) | { ok: false; code: "uri_invalid" };

const ORG_LINK_KEYS = ["o", "m", "a", "t"] as const;
const DIRECT_LINK_KEYS = ["d", "a", "t"] as const;

/**
 * Builds `https://<publisherDomain>/open#o=<OrgUrl>&m=<machineId>&a=<agentId>[&t=<tabId>]`
 * or `...#d=<host>&a=...`. `publisherDomain` comes from build or runtime config, never from
 * the link or the machine. Throws on any value the parser would refuse.
 */
export function agentLinkUrl(publisherDomain: string, link: AgentLink): string {
  if (!isPublicHost(publisherDomain)) throw new Error("publisher domain must be a lowercase DNS name with no port");
  const e = encodeURIComponent;
  const head =
    link.target.kind === "org"
      ? `o=${e(link.target.orgUrl)}&m=${e(link.target.machineId)}`
      : `d=${e(link.target.host)}`;
  const tab = link.tabId === undefined ? "" : `&t=${e(link.tabId)}`;
  const url = `https://${publisherDomain}/open#${head}&a=${e(link.agentId)}${tab}`;
  if (!parseAgentLink(url, publisherDomain).ok) throw new Error("agent link values are not valid");
  return url;
}

/**
 * Parses a verified agent link. The authority must equal `publisherDomain` exactly (an
 * empty or invalid domain, as in a development build, refuses everything), the path is
 * exactly `/open`, there is no query, and the fragment holds exactly one target form plus
 * `a` and an optional `t`. The result names a machine; the caller opens it only when this
 * phone already has that machine, and never adds one from a link.
 */
export function parseAgentLink(url: string, publisherDomain: string): ParsedAgentLink {
  const invalid: ParsedAgentLink = { ok: false, code: "uri_invalid" };
  if (typeof url !== "string" || url.length > AGENT_LINK_MAX_CHARS || !isPublicHost(publisherDomain)) return invalid;
  const m = URI_RE.exec(url);
  if (!m || m[1]!.toLowerCase() !== "https" || m[2] !== publisherDomain || m[3] !== "/open") return invalid;
  if (m[4] !== undefined || m[5] === undefined) return invalid;
  const direct = /(?:^|&)d=/.test(m[5]);
  const p = strictParams(m[5], direct ? DIRECT_LINK_KEYS : ORG_LINK_KEYS);
  if (!p) return invalid;
  const agentId = p.get("a");
  const tabId = p.get("t");
  if (agentId === undefined || !YARAN_ID_RE.test(agentId)) return invalid;
  if (tabId !== undefined && !YARAN_ID_RE.test(tabId)) return invalid;
  let target: AgentLinkTarget;
  if (direct) {
    const host = p.get("d")!;
    if (!isPublicHost(host)) return invalid;
    target = { kind: "direct", host };
  } else {
    const orgUrl = p.get("o");
    const machineId = p.get("m");
    if (orgUrl === undefined || !ORG_URL_RE.test(orgUrl) || machineId === undefined || !MACHINE_ID_RE.test(machineId)) {
      return invalid;
    }
    target = { kind: "org", orgUrl, machineId };
  }
  return tabId === undefined ? { ok: true, target, agentId } : { ok: true, target, agentId, tabId };
}

function assertNever(value: never): never {
  throw new Error(`unhandled uri ${JSON.stringify(value)}`);
}
