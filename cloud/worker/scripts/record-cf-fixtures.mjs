#!/usr/bin/env node
/**
 * Records the Cloudflare API fixtures the provisioning tests compare the fake against.
 *
 * Maintainer-run only (Phases 03 and 19), against a staging account: it creates a throwaway
 * tunnel, DNS record, reusable policy and Access app, captures each response, deletes them
 * again in D21 order, and rewrites `test/provisioning/fixtures/cfapi/*.json` with
 * `"source": "recorded"`.
 *
 * - Runs only with `CF_STAGING_ACCOUNT_ID`, `CF_STAGING_ZONE_ID` and `CF_STAGING_TOKEN`, and
 *   refuses an account whose name does not contain "staging".
 * - Redacts ids, AUDs, tokens, secrets and email addresses before anything is written.
 * - Never part of CI: no test or workflow runs `main`.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:fs, node:path, node:url
 *
 * Used by:
 * scripts/record-cf-fixtures.mjs
 * └── test/provisioning/recorder.test.ts
 * <module-headers:end>
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../test/provisioning/fixtures/cfapi");
const API = "https://api.cloudflare.com/client/v4";

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX = /\b[0-9a-f]{32}(?:[0-9a-f]{32})?\b/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRET_KEYS = new Set(["token", "tunnel_secret", "secret", "credentials_file"]);

/**
 * Replaces ids with stable placeholders (the same id maps to the same placeholder across one
 * capture), secrets with "[redacted]" and emails with user@example.com.
 */
export function redact(value, ids = new Map()) {
  const placeholder = (raw, kind) => {
    const key = raw.toLowerCase();
    if (!ids.has(key)) {
      const n = String(ids.size + 1).padStart(12, "0");
      ids.set(key, kind === "uuid" ? `00000000-0000-4000-8000-${n}` : n.padStart(raw.length, "0"));
    }
    return ids.get(key);
  };
  const walk = (v, key) => {
    if (typeof v === "string") {
      if (SECRET_KEYS.has(key) || /^eyJ[A-Za-z0-9_.=+/-]{16,}/.test(v)) return "[redacted]";
      return v
        .replace(UUID, (m) => placeholder(m, "uuid"))
        .replace(HEX, (m) => placeholder(m, "hex"))
        .replace(EMAIL, "user@example.com");
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value, "");
}

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required; this recorder only runs against a staging account`);
  return v;
}

async function call(token, method, path, body, query) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "yaran-cloud/fixture-recorder" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

export async function main() {
  const account = env("CF_STAGING_ACCOUNT_ID");
  const zone = env("CF_STAGING_ZONE_ID");
  const token = env("CF_STAGING_TOKEN");
  const acct = await call(token, "GET", `/accounts/${account}`);
  if (!/staging/i.test(String(acct.body?.result?.name ?? ""))) {
    throw new Error("refusing to record: the account's name does not contain 'staging'");
  }
  const zoneInfo = await call(token, "GET", `/zones/${zone}`);
  const zoneName = String(zoneInfo.body?.result?.name ?? "");
  const tag = Math.random().toString(16).slice(2, 10);
  const host = `yaran-rec-${tag}.${zoneName}`;
  const tunnelName = `yaran-rec00000-${tag}`;
  const ids = new Map();
  const save = (name, request, response) => {
    const fixture = { source: "recorded", from: `record-cf-fixtures.mjs, ${new Date().toISOString().slice(0, 10)}`, request, response };
    // The names the contract test seeds in the fake, so replaying a request meets the same state.
    const text = JSON.stringify(redact(fixture, ids), null, 2)
      .replaceAll(host, name === "dns-create" ? "laptop-bob.example.com" : "laptop-alice.example.com")
      .replaceAll(tunnelName, name === "error-tunnel-name-conflict" ? "{tunnel_name}" : "yaran-a1b2c3d4-x")
      .replaceAll('"yaran-rec"', '"yaran-a1b2c3d4-"');
    writeFileSync(join(OUT, `${name}.json`), `${text}\n`);
  };
  const rec = async (name, method, path, body, query, savedPath) => {
    const r = await call(token, method, path, body, query);
    if (name) save(name, { method, path: savedPath, ...(query ? { query } : {}), ...(body === undefined ? {} : { body }) }, r);
    return r;
  };
  const A = `/accounts/${account}`;
  const t = await rec("tunnel-create", "POST", `${A}/cfd_tunnel`, { name: tunnelName, config_src: "cloudflare" }, undefined, "/accounts/{account}/cfd_tunnel");
  const tid = t.body.result.id;
  try {
    await rec("error-tunnel-name-conflict", "POST", `${A}/cfd_tunnel`, { name: tunnelName, config_src: "cloudflare" }, undefined, "/accounts/{account}/cfd_tunnel");
    await rec("tunnel-list", "GET", `${A}/cfd_tunnel`, undefined, { include_prefix: "yaran-rec", is_deleted: "false", per_page: "1000", page: "1" }, "/accounts/{account}/cfd_tunnel");
    await rec("tunnel-token", "GET", `${A}/cfd_tunnel/${tid}/token`, undefined, undefined, "/accounts/{account}/cfd_tunnel/{tunnel_id}/token");
    const p = await rec("access-policy-create", "POST", `${A}/access/policies`, { name: `yaran:rec:owner:${tag}`, decision: "allow", include: [{ email: { email: "user@example.com" } }] }, undefined, "/accounts/{account}/access/policies");
    const pid = p.body.result.id;
    const app = await rec("access-app-create", "POST", `${A}/access/apps`, { type: "self_hosted", name: `yaran:rec:m:${tag}`, domain: host, policies: [{ id: pid, precedence: 1 }] }, undefined, "/accounts/{account}/access/apps");
    const aid = app.body.result.id;
    await rec("access-app-list", "GET", `${A}/access/apps`, undefined, { domain: host, exact: "true", per_page: "50", page: "1" }, "/accounts/{account}/access/apps");
    await rec("access-policy-list", "GET", `${A}/access/policies`, undefined, { per_page: "1000", page: "1" }, "/accounts/{account}/access/policies");
    const config = { ingress: [{ hostname: host, service: "http://127.0.0.1:3890", originRequest: { access: { required: true, teamName: "rec", audTag: [app.body.result.aud] } } }, { service: "http_status:404" }], originRequest: {} };
    await rec("tunnel-config-put", "PUT", `${A}/cfd_tunnel/${tid}/configurations`, { config }, undefined, "/accounts/{account}/cfd_tunnel/{tunnel_id}/configurations");
    const d = await rec("dns-create", "POST", `/zones/${zone}/dns_records`, { type: "CNAME", name: host, content: `${tid}.cfargotunnel.com`, proxied: true, ttl: 1, comment: `yaran:rec:m:${tag}` }, undefined, "/zones/{zone}/dns_records");
    await rec("error-dns-same-name", "POST", `/zones/${zone}/dns_records`, { type: "CNAME", name: host, content: "x.cfargotunnel.com", proxied: true, ttl: 1, comment: "c" }, undefined, "/zones/{zone}/dns_records");
    await rec("dns-list", "GET", `/zones/${zone}/dns_records`, undefined, { name: host, type: "CNAME", per_page: "100", page: "1" }, "/zones/{zone}/dns_records");
    // Teardown in D21 order.
    await call(token, "DELETE", `/zones/${zone}/dns_records/${d.body.result.id}`);
    await call(token, "DELETE", `${A}/cfd_tunnel/${tid}/connections`);
    await call(token, "DELETE", `${A}/cfd_tunnel/${tid}`);
    await call(token, "DELETE", `${A}/access/apps/${aid}`);
    await call(token, "DELETE", `${A}/access/policies/${pid}`);
  } catch (err) {
    console.error(`recording failed; remove the staging resources tagged ${tag} by hand`);
    throw err;
  }
  console.log(`recorded fixtures into ${OUT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
