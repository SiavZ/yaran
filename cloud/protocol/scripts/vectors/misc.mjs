/**
 * Generates the decision-table fixtures: `uri/add-org.json`, `uri/add-machine.json`,
 * `uri/agent-link.json`, `uri/handoff-redirect.json`, `uri/control-urls.json`, `ua/ua.json`
 * and `version/negotiate.json` (Design §3, §8, §10, §11; the two newer URI forms in
 * docs/operations/mobile-parity-contracts.md).
 *
 * These are rules rather than derived bytes, so the expected outcome of each row is
 * written here by hand from the contract text; the generator only keeps the files in one
 * canonical form.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * scripts/vectors/misc.mjs
 * └── scripts/gen-vectors.mjs
 * <module-headers:end>
 */

const ORG = "https://cp.example.com";
const ORG_ENC = "https%3A%2F%2Fcp.example.com";

function addOrg() {
  return {
    description: "yaranapp://add-org?u=<pct-encoded OrgUrl>, total <= 512 chars. build: expect is the URI or null (refused). parse: expect is {org_url} or uri_invalid.",
    build: [
      { org_url: ORG, expect: `yaranapp://add-org?u=${ORG_ENC}` },
      { org_url: "https://yaran.cp.example.org", expect: "yaranapp://add-org?u=https%3A%2F%2Fyaran.cp.example.org" },
      { org_url: "http://cp.example.com", expect: null },
      { org_url: "https://cp.example.com/", expect: null },
      { org_url: "https://cp.example.com:8443", expect: null },
      { org_url: "https://CP.example.com", expect: null },
      { org_url: "https://localhost", expect: null },
      { org_url: `https://${Array.from({ length: 8 }, () => "a".repeat(63)).join(".")}.com`, expect: null },
    ],
    parse: [
      { uri: `yaranapp://add-org?u=${ORG_ENC}`, expect: { org_url: ORG } },
      { uri: `YaranApp://add-org?u=${ORG_ENC}`, expect: { org_url: ORG } },
      { uri: `yaranapp://add-org?u=${ORG_ENC}&utm=qr`, expect: { org_url: ORG } },
      { uri: `yaranapp://add-org?u=${ORG}`, expect: { org_url: ORG } },
      { uri: `yaranapp://add-org?u=${ORG_ENC}&u=${ORG_ENC}`, expect: "uri_invalid" },
      { uri: "yaranapp://add-org", expect: "uri_invalid" },
      { uri: "yaranapp://add-org?u=http%3A%2F%2Fcp.example.com", expect: "uri_invalid" },
      { uri: "yaranapp://add-org?u=%E0%A4%A", expect: "uri_invalid" },
      { uri: `yaranapp://add-orgs?u=${ORG_ENC}`, expect: "uri_invalid" },
      { uri: `https://add-org?u=${ORG_ENC}`, expect: "uri_invalid" },
      { uri: `yaranapp://add-org?u=${ORG_ENC}&pad=${"x".repeat(480)}`, expect: "uri_invalid" },
    ],
  };
}

const MACHINE = "yaran.example.com";
const TS_HOST = "laptop.tail1234.ts.net";
const amUri = (u) => `yaranapp://add-machine?u=${u}`;
const amEnc = (host) => amUri(`https%3A%2F%2F${host}`);

function addMachine() {
  return {
    description:
      "yaranapp://add-machine?u=<pct-encoded https origin>, total <= 512 chars. STRICT: exactly one parameter u; no path, fragment, empty pair or other parameter; the host is lowercase, two or more labels, alphabetic TLD, no port, IP literal, userinfo or xn-- label. It only pre-fills Confirm machine, never adds. parseAppUri answers uri_invalid for it, so existing AppUri switches are unchanged. build: expect is the URI or null (refused). parse: expect is {host} or uri_invalid.",
    build: [
      { host: TS_HOST, expect: amEnc(TS_HOST) },
      { host: MACHINE, expect: amEnc(MACHINE) },
      { host: "localhost", expect: null },
      { host: "192.168.1.20", expect: null },
      { host: "Yaran.example.com", expect: null },
      { host: "yaran.example.com:8443", expect: null },
      { host: "xn--yrn-1na.example.com", expect: null },
      { host: "", expect: null },
      { host: `${Array.from({ length: 8 }, () => "a".repeat(63)).join(".")}.com`, expect: null },
    ],
    parse: [
      { uri: amEnc(TS_HOST), expect: { host: TS_HOST } },
      { uri: `YARANAPP://add-machine?u=https%3A%2F%2F${MACHINE}`, expect: { host: MACHINE } },
      { uri: amUri(`https://${MACHINE}`), expect: { host: MACHINE } },
      { uri: `${amEnc(MACHINE)}&utm=qr`, expect: "uri_invalid" },
      { uri: `${amEnc(MACHINE)}&u=https%3A%2F%2F${MACHINE}`, expect: "uri_invalid" },
      { uri: `${amEnc(MACHINE)}&`, expect: "uri_invalid" },
      { uri: `${amEnc(MACHINE)}#x=1`, expect: "uri_invalid" },
      { uri: `${amEnc(MACHINE)}#`, expect: "uri_invalid" },
      { uri: `yaranapp://add-machine/x?u=https%3A%2F%2F${MACHINE}`, expect: "uri_invalid" },
      { uri: "yaranapp://add-machine", expect: "uri_invalid" },
      { uri: "yaranapp://add-machine?u", expect: "uri_invalid" },
      { uri: amUri(`http%3A%2F%2F${MACHINE}`), expect: "uri_invalid" },
      { uri: amEnc(`${MACHINE}%2F`), expect: "uri_invalid" },
      { uri: amEnc(`${MACHINE}%3A8443`), expect: "uri_invalid" },
      { uri: amEnc(`user%40${MACHINE}`), expect: "uri_invalid" },
      { uri: amEnc("10.0.0.5"), expect: "uri_invalid" },
      { uri: amEnc("localhost"), expect: "uri_invalid" },
      { uri: amEnc("Yaran.example.com"), expect: "uri_invalid" },
      { uri: amEnc("xn--yrn-1na.example.com"), expect: "uri_invalid" },
      { uri: amUri("%E0%A4%A"), expect: "uri_invalid" },
      { uri: `https://add-machine?u=https%3A%2F%2F${MACHINE}`, expect: "uri_invalid" },
      { uri: `yaranapp://add-org?u=https%3A%2F%2F${MACHINE}`, expect: "uri_invalid" },
    ],
  };
}

const PUBLISHER = "apps.example.org";
const MID = "0b5f9a8e-6d0e-4f43-9a51-1d6f7d9b1c2a";
const LINK = `https://${PUBLISHER}/open#`;
const O = `o=${ORG_ENC}&m=${MID}`;
const orgTarget = { kind: "org", orgUrl: ORG, machineId: MID };
const tsTarget = { kind: "direct", host: TS_HOST };

function agentLink() {
  const bad = (url) => ({ url, expect: "uri_invalid" });
  const noBuild = (target, agentId) => ({ link: { target, agentId }, expect: null });
  return {
    description:
      "Verified agent link: https://<publisher_domain>/open#o=<OrgUrl>&m=<machine Uuid>&a=<YaranId>[&t=<YaranId>] or #d=<host>&a=...[&t=...]. publisher_domain comes from build or runtime config (Session.callbackMode https domain), never from the link. STRICT: exact lowercase authority, path exactly /open, no query, exactly one target form, a required, t optional, no other, empty or duplicate parameter. The link opens only a machine this phone already has; it never adds one. build: link -> expect URL or null (throws). parse: expect is the link or uri_invalid.",
    publisher_domain: PUBLISHER,
    build: [
      { link: { target: orgTarget, agentId: "a1b2" }, expect: `${LINK}${O}&a=a1b2` },
      { link: { target: orgTarget, agentId: "a1b2", tabId: "t/9#x" }, expect: `${LINK}${O}&a=a1b2&t=t%2F9%23x` },
      { link: { target: tsTarget, agentId: "s-1" }, expect: `${LINK}d=${TS_HOST}&a=s-1` },
      noBuild({ kind: "direct", host: "10.0.0.5" }, "s-1"),
      noBuild({ kind: "org", orgUrl: "http://cp.example.com", machineId: MID }, "s-1"),
      noBuild({ kind: "org", orgUrl: ORG, machineId: "machine-1" }, "s-1"),
      noBuild(orgTarget, "has space"),
      noBuild(orgTarget, ""),
      noBuild(orgTarget, "x".repeat(129)),
    ],
    build_bad_domain: ["", "localhost", "Apps.example.org", "apps.example.org:443", "https://apps.example.org"],
    parse: [
      { url: `${LINK}${O}&a=a1b2`, expect: { target: orgTarget, agentId: "a1b2" } },
      { url: `${LINK}a=a1b2&t=t%2F9%23x&${O}`, expect: { target: orgTarget, agentId: "a1b2", tabId: "t/9#x" } },
      { url: `HTTPS://${PUBLISHER}/open#d=${TS_HOST}&a=s-1`, expect: { target: tsTarget, agentId: "s-1" } },
      bad(`${LINK}${O}`),
      bad(`${LINK}${O}&a=a1b2&x=1`),
      bad(`${LINK}${O}&a=a1b2&a=a1b2`),
      bad(`${LINK}${O}&a=a1b2&`),
      bad(`${LINK}${O}&a`),
      bad(`${LINK}${O}&a=a1b2&t=`),
      bad(`${LINK}${O}&d=${TS_HOST}&a=a1b2`),
      bad(`${LINK}d=${TS_HOST}&m=${MID}&a=a1b2`),
      bad(`${LINK}d=10.0.0.5&a=a1b2`),
      bad(`${LINK}d=${TS_HOST}%3A8443&a=a1b2`),
      bad(`${LINK}o=http%3A%2F%2Fcp.example.com&m=${MID}&a=a1b2`),
      bad(`${LINK}o=${ORG_ENC}&m=MACHINE&a=a1b2`),
      bad(`${LINK}${O}&a=has%20space`),
      bad(`${LINK}${O}&a=%E0%A4%A`),
      bad(`https://${PUBLISHER}/open?${O}&a=a1b2`),
      bad(`https://${PUBLISHER}/open?x=1#${O}&a=a1b2`),
      bad(`https://${PUBLISHER}/open/#${O}&a=a1b2`),
      bad(`https://${PUBLISHER}/Open#${O}&a=a1b2`),
      bad(`http://${PUBLISHER}/open#${O}&a=a1b2`),
      bad(`https://evil.example.net/open#${O}&a=a1b2`),
      bad(`https://${PUBLISHER}.evil.example.net/open#${O}&a=a1b2`),
      bad(`https://user@${PUBLISHER}/open#${O}&a=a1b2`),
      bad(`https://${PUBLISHER}:443/open#${O}&a=a1b2`),
      bad(`https://Apps.example.org/open#${O}&a=a1b2`),
      bad(`yaranapp://${PUBLISHER}/open#${O}&a=a1b2`),
    ],
    parse_without_domain: { url: `${LINK}${O}&a=a1b2`, domains: ["", "localhost", "Apps.example.org"], expect: "uri_invalid" },
  };
}

function handoffRedirect() {
  const configured = ["https://app.example.com/auth/callback"];
  const row = (redirect, build, expect) => ({ redirect, build, expect });
  return {
    description: "The §8 redirect allowlist. build null means the parameter was absent (release). expect true means the redirect may receive the handoff.",
    configured,
    cases: [
      row("https://app.example.com/auth/callback", null, true),
      row("https://app.example.com/auth/callback", "release", true),
      row("yaranapp://auth/callback", "release", false),
      row("yaranapp://auth/callback", null, false),
      row("yaranapp://auth/callback", "dev", true),
      row("https://app.example.com/auth/callback", "dev", false),
      row("https://app.example.com/auth/callback/", "release", false),
      row("https://APP.example.com/auth/callback", "release", false),
      row("https://app.example.com/auth/Callback", "release", false),
      row("https://app.example.com/auth/callback?x=1", "release", false),
      row("https://user@app.example.com/auth/callback", "release", false),
      row("http://app.example.com/auth/callback", "release", false),
      row("https://app.example.com:443/auth/callback", "release", false),
      row("YARANAPP://auth/callback", "dev", false),
      row("yaranapp://auth/callback?x=1", "dev", false),
    ],
  };
}

function controlUrls() {
  const host = "laptop-ada.example.com";
  const row = (uri, expect, extra = {}) => ({ uri, loaded_host: host, expect, ...extra });
  return {
    description: "In-WebView control URLs (§10). expect: reauth | home | settings | ignore; code names the registry code logged for an ignored URI that is invalid rather than merely for another host.",
    cases: [
      row(`yaranapp://reauth?host=${host}`, "reauth"),
      row(`YARANAPP://reauth?host=${host}`, "reauth"),
      row(`yaranapp://reauth?host=${host}&why=expired`, "reauth"),
      row("yaranapp://reauth?host=other-ada.example.com", "ignore"),
      row("yaranapp://reauth", "ignore", { code: "uri_invalid" }),
      row(`yaranapp://reauth?host=${host}&host=${host}`, "ignore", { code: "uri_invalid" }),
      row("yaranapp://reauth?host=Laptop-Ada.example.com", "ignore", { code: "uri_invalid" }),
      row("yaranapp://reauth?host=laptop_ada.example.com", "ignore", { code: "uri_invalid" }),
      row(`yaranapp://reauth?host=${host}:443`, "ignore", { code: "uri_invalid" }),
      row("yaranapp://home", "home"),
      row("yaranapp://home?from=menu", "home"),
      row("yaranapp://settings", "settings"),
      row("yaranapp://settings?tab=push", "settings"),
      row("yaranapp://explode", "ignore", { code: "uri_invalid" }),
      row("yaranapp://add-org?u=https%3A%2F%2Fcp.example.com", "ignore"),
    ],
  };
}

function ua() {
  const android = "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP4A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36";
  const ios = "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
  const p = (version, os, form) => ({ version, os, form });
  return {
    description: "The §11 UA token. parse: expect is {version, os, form} or null. build: the token for the inputs.",
    parse: [
      { ua: `${android} YaranApp/1.2.3 (android; phone)`, expect: p("1.2.3", "android", "phone") },
      { ua: `${ios} YaranApp/1.2.3-beta.1 (ios; tablet)`, expect: p("1.2.3-beta.1", "ios", "tablet") },
      { ua: "YaranApp/1.0.0 (android; tablet)", expect: p("1.0.0", "android", "tablet") },
      { ua: "YaranApp/2.0.0 (ios; phone) Extra/1", expect: p("2.0.0", "ios", "phone") },
      { ua: android, expect: null },
      { ua: "XYaranApp/1.0.0 (android; phone)", expect: null },
      { ua: "YaranApp/1.0.0 (windows; phone)", expect: null },
      { ua: "YaranApp/1.0 (android; phone)", expect: null },
      { ua: "YaranApp/1.0.0 (android; phone)extra", expect: null },
      { ua: "YaranApp/12345.0.0 (android; phone)", expect: null },
      { ua: "YaranApp/1.0.0 (Android; phone)", expect: null },
      { ua: "YaranApp/1.0.0  (android; phone)", expect: null },
    ],
    build: [
      { input: p("1.2.3", "android", "phone"), token: "YaranApp/1.2.3 (android; phone)" },
      { input: p("10.0.1-rc.2", "ios", "tablet"), token: "YaranApp/10.0.1-rc.2 (ios; tablet)" },
    ],
  };
}

function negotiate() {
  const r = (min, max) => ({ min, max });
  return {
    description: "§3 negotiation: n = min(cmax, smax), require n >= max(cmin, smin). expect is {version} or {update: client|server}; deprecated is the server's deprecation entry for the chosen n, or null.",
    cases: [
      { name: "overlap, equal", client: r(1, 1), server: r(1, 1), expect: { version: 1 }, deprecated: null },
      { name: "client newer", client: r(1, 2), server: r(1, 1), expect: { version: 1 }, deprecated: null },
      { name: "server newer", client: r(1, 1), server: r(1, 2), expect: { version: 1 }, deprecated: null },
      { name: "partial overlap", client: r(1, 3), server: r(2, 4), expect: { version: 3 }, deprecated: null },
      { name: "disjoint, client too old", client: r(1, 1), server: r(2, 3), expect: { update: "client" }, deprecated: null },
      { name: "disjoint, server too old", client: r(2, 3), server: r(1, 1), expect: { update: "server" }, deprecated: null },
      {
        name: "deprecated choice",
        client: r(1, 1),
        server: r(1, 2),
        deprecations: [{ protocol: 1, after: "2027-12-01" }],
        expect: { version: 1 },
        deprecated: { protocol: 1, after: "2027-12-01" },
      },
      {
        name: "deprecation of another version is not ours",
        client: r(1, 2),
        server: r(1, 2),
        deprecations: [{ protocol: 1, after: "2027-12-01" }],
        expect: { version: 2 },
        deprecated: null,
      },
    ],
  };
}

export async function generate() {
  return {
    "uri/add-org.json": addOrg(),
    "uri/add-machine.json": addMachine(),
    "uri/agent-link.json": agentLink(),
    "uri/handoff-redirect.json": handoffRedirect(),
    "uri/control-urls.json": controlUrls(),
    "ua/ua.json": ua(),
    "version/negotiate.json": negotiate(),
  };
}
