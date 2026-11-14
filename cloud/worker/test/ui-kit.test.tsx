/**
 * The console UI kit: escaping, chips, the confirm pattern's focus order, CSP and a11y on
 * every setup page, the colour-literal lint on console.css, and the verbatim token copy.
 *
 * <module-headers:begin>
 * Uses:
 * test/ui-kit.test.tsx
 * ├── scripts/copy-ui-kit-assets.ts
 * ├── src/console/ui/components.tsx
 * ├── src/console/ui/confirm.tsx
 * ├── src/console/ui/shell.tsx
 * ├── src/setup/pages-steps.tsx
 * ├── src/setup/pages.tsx
 * ├── src/setup/token-template.ts
 * └── test/helpers/html-checks.ts
 * External: node:fs, node:os, node:path, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { copyUiKitAssets, defaultSources } from "../scripts/copy-ui-kit-assets.ts";
import { Chip, Field, Notice, Table } from "../src/console/ui/components.tsx";
import { ConfirmBody } from "../src/console/ui/confirm.tsx";
import { renderPage, Shell } from "../src/console/ui/shell.tsx";
import { PERMISSIONS } from "../src/setup/token-template.ts";
import { ClaimInvalidPage, ClaimPage, DomainPage, DonePage, IdpPage, KeysPage, OrgPage, ZonePage, AccessPage } from "../src/setup/pages-steps.tsx";
import { CodePage, LockedPage, SecretsPage, TokenPage } from "../src/setup/pages.tsx";
import { a11yViolations, cspViolations } from "./helpers/html-checks.ts";

const page = (node: Parameters<typeof renderPage>[0]) => renderPage(node);

test("names render as escaped chips, never quoted", async () => {
  const html = await page(<Shell title="t"><p>Remove <Chip>{'<img src=x onerror=alert(1)>'}</Chip></p></Shell>);
  expect(html).toContain('<code class="chip">&lt;img src=x onerror=alert(1)&gt;</code>');
  expect(cspViolations(html)).toEqual([]);
});

test("the shell loads only same-origin assets and is dark", async () => {
  const html = await page(<Shell title="t" />);
  expect(html).toMatch(/^<!doctype html><html lang="en" class="dark">/);
  expect(html).toContain('<script type="module" src="/console/enhance.js"></script>');
  expect(html).not.toMatch(/https?:\/\//);
});

test("fields wire label, hint and error; tables have captions; notices carry a word, not only colour", async () => {
  const html = await page(
    <Shell title="t">
      <Field id="x" label="X" hint="h" error="e" />
      <Table caption="c" headers={["a"]}><tr><td>1</td></tr></Table>
      <Notice tone="error">bad</Notice>
    </Shell>,
  );
  expect(html).toContain('aria-describedby="x-hint x-error"');
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain('<th scope="col">a</th>');
  expect(html).toContain('<span class="sr-only">Error:</span>');
  expect(a11yViolations(html)).toEqual([]);
});

test("the confirm pattern puts Cancel first and autofocused, then the destructive button", async () => {
  const html = await page(<Shell title="t"><ConfirmBody lead="Revoke" target="laptop" consequence="gone" action="/x" cancelHref="/back" confirmLabel="Revoke" /></Shell>);
  expect(a11yViolations(html)).toEqual([]);
  expect(html.indexOf("Cancel")).toBeLessThan(html.indexOf("btn-destructive"));
  expect(html).toContain('<form method="post" action="/x"');
});

const record = { step: "claim" as const, admin_email: "ada@example.org", cp_host: "cp.example.org", team_domain: "t.cloudflareaccess.com", workers_dev_disabled: false };
const SETUP_PAGES = {
  secrets: SecretsPage({ problems: ["setup_code_short", "data_key_missing"] }),
  locked: LockedPage(),
  code: CodePage({ error: "setup_code_invalid" }),
  token: TokenPage({ envToken: false, probe: PERMISSIONS.map((permission) => ({ permission, outcome: "missing" as const })), accountProblem: "several" }),
  org: OrgPage({ problem: "no_org" }),
  zone: ZonePage({ zones: [{ id: "z1", name: "example.org" }], problem: "hostname_conflict" }),
  access: AccessPage({ record }),
  domain: DomainPage({ record, problem: "dashboard_required" }),
  idp: IdpPage({ idps: [{ id: "c", name: "Cloudflare", type: "cloudflare" }], teamDomain: "t.cloudflareaccess.com" }),
  keys: KeysPage(),
  claim: ClaimPage({ record, link: "https://cp.example.org/setup/claim?c=abc" }),
  claimInvalid: ClaimInvalidPage(),
  done: DonePage({ record }),
};

describe("setup pages", () => {
  test.each(Object.entries(SETUP_PAGES))("%s passes the CSP and accessibility checks", async (_name, node) => {
    const html = await page(node);
    expect(cspViolations(html)).toEqual([]);
    expect(a11yViolations(html)).toEqual([]);
  });
  test("the final page says when turning workers.dev off failed", async () => {
    expect(await page(SETUP_PAGES.done)).toContain("Turning off the workers.dev address failed");
  });
});

describe("console.css", () => {
  const css = readFileSync(new URL("../assets/console/console.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  test("uses no colour literal, only ui-kit token variables", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color-mix)\(/i);
    expect(css).not.toMatch(/:\s*(white|black|red|green|blue|gray|grey)\b/i);
    for (const v of css.match(/var\(--[a-z0-9-]+/g) ?? []) {
      expect(["--control-h", "--gap", "--radius", "--background", "--foreground", "--card", "--card-foreground", "--primary", "--primary-foreground", "--muted-foreground", "--accent", "--border", "--input", "--ring", "--destructive", "--popover", "--popover-foreground"]).toContain(v.slice(4));
    }
  });
});

describe("ui-kit token copy", () => {
  test("copies tokens.css and the font byte for byte", () => {
    const dir = mkdtempSync(join(tmpdir(), "uikit-"));
    writeFileSync(join(dir, "tokens.css"), ":root { --background: x; }\n.dark { --background: y; }\n");
    writeFileSync(join(dir, "font.woff2"), new Uint8Array([1, 2, 3]));
    copyUiKitAssets({ tokens: join(dir, "tokens.css"), font: join(dir, "font.woff2") }, join(dir, "assets"));
    expect(readFileSync(join(dir, "assets/console/tokens.css"))).toEqual(readFileSync(join(dir, "tokens.css")));
    expect(readFileSync(join(dir, "assets/console/fonts/geist-latin-wght-normal.woff2"))).toEqual(Buffer.from([1, 2, 3]));
  });
  test("fails loudly when ui-kit is missing", () => {
    expect(() => copyUiKitAssets({ tokens: "/nope/tokens.css", font: "/nope/f.woff2" }, tmpdir())).toThrow(/ui-kit tokens not found/);
  });
  const repoRoot = new URL("../../..", import.meta.url).pathname;
  const kit = defaultSources(repoRoot);
  test.skipIf(!existsSync(kit.tokens) || !existsSync(join(repoRoot, "cloud/worker/assets/console/tokens.css")))("the built tokens.css equals packages/ui-kit/src/tokens.css", () => {
    expect(readFileSync(join(repoRoot, "cloud/worker/assets/console/tokens.css"))).toEqual(readFileSync(kit.tokens));
  });
});
