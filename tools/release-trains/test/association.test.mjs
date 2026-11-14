/**
 * Tests for check-association.mjs: committed assetlinks.json and
 * apple-app-site-association against the signing cert and identifiers, and the `--live`
 * byte comparison against a local HTTP fixture server (including a redirect, which fails).
 *
 * <module-headers:begin>
 * Uses:
 * test/association.test.mjs
 * ├── check-association.mjs
 * ├── lib/repo.mjs
 * └── test/helpers.mjs
 * External: node:assert/strict, node:http, node:test
 *
 * Used by: entry point (node --test 'tools/release-trains/test/*.test.mjs', via npm test in tools/release-trains and the gates.yml release-trains job)
 * <module-headers:end>
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { run } from "../check-association.mjs";
import { colonFingerprint } from "../lib/repo.mjs";
import { GOOD_CERT, OTHER_CERT, capture, makeTree, publisherFiles } from "./helpers.mjs";

const APP = "org.example.yaran";
const assetlinks = ({ pkg = APP, cert = GOOD_CERT } = {}) => [
  { relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: [colonFingerprint(cert)] } },
];
const aasa = ({ paths = ["/auth/callback", "/oauth/callback"] } = {}) => ({
  applinks: { details: [{ appIDs: [`ABCDE12345.${APP}`], components: paths.map((p) => ({ "/": p })) }] },
});

function site(over = {}) {
  return makeTree({
    ...publisherFiles(),
    "mobile/android/signing/app-signing-cert.sha256": `${GOOD_CERT}\n`,
    "publisher-site/.well-known/assetlinks.json": over.assetlinks ?? assetlinks(),
    "publisher-site/.well-known/apple-app-site-association": over.aasa ?? aasa(),
  });
}

async function check(root, ...args) {
  const out = capture();
  const status = await run(["--root", root, ...args], out.log);
  return { status, text: out.text() };
}

test("agreeing committed files pass", async () => {
  const { status, text } = await check(site());
  assert.equal(status, 0, text);
});

test("the legacy `paths` form of the AASA is accepted", async () => {
  const legacy = { applinks: { details: [{ appID: `ABCDE12345.${APP}`, paths: ["/auth/callback", "/oauth/callback"] }] } };
  assert.equal((await check(site({ aasa: legacy }))).status, 0);
});

test("a wrong fingerprint fails", async () => {
  const { status, text } = await check(site({ assetlinks: assetlinks({ cert: OTHER_CERT }) }));
  assert.equal(status, 1);
  assert.match(text, /does not list the app-signing fingerprint/);
});

test("a wrong package fails", async () => {
  const { status, text } = await check(site({ assetlinks: assetlinks({ pkg: "com.attacker.app" }) }));
  assert.equal(status, 1);
  assert.match(text, /no handle_all_urls statement for package org.example.yaran/);
});

test("a missing /auth/callback path fails", async () => {
  const { status, text } = await check(site({ aasa: aasa({ paths: ["/oauth/callback"] }) }));
  assert.equal(status, 1);
  assert.match(text, /does not cover \/auth\/callback/);
});

test("missing association files fail and name Phase 21", async () => {
  const root = makeTree({ ...publisherFiles(), "mobile/android/signing/app-signing-cert.sha256": `${GOOD_CERT}\n` });
  const { status, text } = await check(root);
  assert.equal(status, 1);
  assert.match(text, /Phase 21 commits the association files/);
});

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test("--live passes when the served bytes equal the committed files", async () => {
  const root = site();
  const files = {
    "/.well-known/assetlinks.json": `${JSON.stringify(assetlinks(), null, 2)}\n`,
    "/.well-known/apple-app-site-association": `${JSON.stringify(aasa(), null, 2)}\n`,
  };
  await withServer((req, res) => res.end(files[req.url]), async (base) => {
    const { status, text } = await check(root, "--live", "--base-url", base);
    assert.equal(status, 0, text);
  });
});

test("--live fails on a redirect and on different bytes", async () => {
  const root = site();
  await withServer((req, res) => {
    if (req.url.endsWith("assetlinks.json")) {
      res.writeHead(301, { location: "https://elsewhere.example/.well-known/assetlinks.json" });
      res.end();
    } else res.end("{}");
  }, async (base) => {
    const { status, text } = await check(root, "--live", "--base-url", base);
    assert.equal(status, 1);
    assert.match(text, /answered 301 \(redirect to https:\/\/elsewhere.example/);
    assert.match(text, /apple-app-site-association differs from the committed/);
  });
});
