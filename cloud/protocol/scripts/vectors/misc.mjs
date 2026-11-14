/**
 * Generates the decision-table fixtures: `uri/add-org.json`, `uri/handoff-redirect.json`,
 * `uri/control-urls.json`, `ua/ua.json` and `version/negotiate.json` (Design §3, §8, §10,
 * §11).
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
    "uri/handoff-redirect.json": handoffRedirect(),
    "uri/control-urls.json": controlUrls(),
    "ua/ua.json": ua(),
    "version/negotiate.json": negotiate(),
  };
}
