/**
 * Tests for check-deploy-tree.mjs: the JSONC reader, the D19 wrangler-config rules, the
 * self-containment rule and the publisher callback rule, on fixture trees.
 *
 * <module-headers:begin>
 * Uses:
 * test/deploy-tree.test.mjs
 * ├── check-deploy-tree.mjs
 * ├── lib/jsonc.mjs
 * └── test/helpers.mjs
 * External: node:assert/strict, node:path, node:test
 *
 * Used by: entry point (node --test 'tools/release-trains/test/*.test.mjs', via npm test in tools/release-trains and the gates.yml release-trains job)
 * <module-headers:end>
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { run } from "../check-deploy-tree.mjs";
import { parseJsonc } from "../lib/jsonc.mjs";
import { capture, makeTree } from "./helpers.mjs";

const wrangler = (over = {}, header = "// generated deploy tree\n") =>
  `${header}${JSON.stringify(
    {
      name: "yaran-cloud",
      main: "src/index.ts",
      workers_dev: true,
      preview_urls: false,
      routes: [],
      d1_databases: [{ binding: "DB", database_name: "yaran-cloud" }],
      vars: { APP_CALLBACK_URLS: "https://yaran.example.org/auth/callback" },
      ...over,
    },
    null,
    2,
  )}\n`;

function tree({ config = wrangler(), deps = { "@yaran/protocol": "file:vendor/cloud-protocol" }, lockResolved = "vendor/cloud-protocol", domain = "yaran.example.org", vendor = true } = {}) {
  const files = {
    "worker/wrangler.jsonc": config,
    "worker/package.json": { name: "yaran-cloud-worker", version: "1.0.0", dependencies: deps },
    "worker/package-lock.json": {
      lockfileVersion: 3,
      packages: { "": { dependencies: deps }, "node_modules/@yaran/protocol": { resolved: lockResolved, link: true } },
    },
    "publisher.json": { publisher_domain: domain },
  };
  if (vendor) files["worker/vendor/cloud-protocol/package.json"] = { name: "@yaran/protocol" };
  return makeTree(files);
}

function check(root, ...args) {
  const out = capture();
  const status = run([path.join(root, "worker"), "--publisher", path.join(root, "publisher.json"), ...args], out.log);
  return { status, text: out.text() };
}

test("parseJsonc drops comments and trailing commas but keeps strings intact", () => {
  const text = `{
    // line comment
    "url": "https://x.example/a//b", /* block */
    "s": "a,]", "list": [1, 2,],
  }`;
  assert.deepEqual(parseJsonc(text), { url: "https://x.example/a//b", s: "a,]", list: [1, 2] });
});

test("the clean fixture tree passes", () => {
  const { status, text } = check(tree(), "--tag", "yaran-cloud-v1.0.0");
  assert.equal(status, 0, text);
});

test("a file:../protocol dependency fails self-containment", () => {
  const { status, text } = check(tree({ deps: { "@yaran/protocol": "file:../protocol" }, lockResolved: "../protocol" }));
  assert.equal(status, 1);
  assert.match(text, /package.json dependencies.@yaran\/protocol = file:..\/protocol points outside the tree/);
  assert.match(text, /package-lock.json packages\["node_modules\/@yaran\/protocol"\].resolved = ..\/protocol/);
});

test("workspace: and link: specs and a missing vendored protocol fail", () => {
  const ws = check(tree({ deps: { a: "workspace:*", b: "link:../b" } }));
  assert.equal(ws.status, 1);
  assert.match(ws.text, /dependencies.a = workspace:\*/);
  assert.match(ws.text, /dependencies.b = link:..\/b/);
  assert.match(check(tree({ vendor: false })).text, /vendor\/cloud-protocol\/package.json is missing/);
});

for (const [name, over, pattern] of [
  ["workers_dev false", { workers_dev: false }, /workers_dev must be true/],
  ["preview_urls true", { preview_urls: true }, /preview_urls must be false/],
  ["a routes entry", { routes: [{ pattern: "api.example.org/*", zone_name: "example.org" }] }, /"routes" must be empty/],
  ["a custom domain", { routes: [{ pattern: "cp.example.org", custom_domain: true }] }, /custom_domain entry/],
  ["a route", { route: "example.org/*" }, /a "route" is set/],
  ["a D1 database_id", { d1_databases: [{ binding: "DB", database_name: "x", database_id: "abc" }] }, /carries a database_id/],
  ["an env block with preview_urls", { env: { staging: { preview_urls: true } } }, /env.staging: preview_urls must be false/],
]) {
  test(`${name} fails the wrangler-config check`, () => {
    const { status, text } = check(tree({ config: wrangler(over) }));
    assert.equal(status, 1);
    assert.match(text, pattern);
  });
}

test("a placeholder APP_CALLBACK_URLS fails for a stable tag, and a mismatch always fails", () => {
  const placeholder = tree({ domain: "<publisher-domain>", config: wrangler({ vars: { APP_CALLBACK_URLS: "https://<publisher-domain>/auth/callback" } }) });
  const stable = check(placeholder, "--tag", "yaran-cloud-v1.0.0");
  assert.equal(stable.status, 1);
  assert.match(stable.text, /still holds the placeholder/);
  assert.equal(check(placeholder, "--tag", "yaran-cloud-v1.0.0-rc.1").status, 0);

  const wrong = check(tree({ config: wrangler({ vars: { APP_CALLBACK_URLS: ["https://other.example.org/auth/callback"] } }) }));
  assert.equal(wrong.status, 1);
  assert.match(wrong.text, /expected \["https:\/\/yaran.example.org\/auth\/callback"\]/);
  const scheme = check(tree({ config: wrangler({ vars: { APP_CALLBACK_URLS: "https://yaran.example.org/auth/callback,yaranapp://auth/callback" } }) }));
  assert.match(scheme.text, /lists a yaranapp:\/\/ callback/);
});

test("--config-only checks the worker config (dev database_id allowed) and Phase 07's template", () => {
  const root = makeTree({
    "cloud/worker/wrangler.jsonc": wrangler({ d1_databases: [{ binding: "DB", database_name: "yaran-cloud", database_id: "00000000-0000-0000-0000-000000000000" }] }),
    "cloud/worker/deploy-template/wrangler.template.jsonc": wrangler({ preview_urls: true }),
  });
  const out = capture();
  assert.equal(run([path.join(root, "cloud/worker"), "--config-only"], out.log), 1);
  assert.match(out.text(), /deploy-template\/wrangler.template.jsonc: preview_urls must be false/);
  assert.match(out.text(), /ok    wrangler.jsonc: workers_dev true/);
});
