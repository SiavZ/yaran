/**
 * The console UI kit: escaping, chips, the confirm pattern's focus order, CSP and a11y on
 * every setup page, the colour-literal lint on console.css, and the verbatim token copy.
 *
 * <module-headers:begin>
 * Uses:
 * test/node/ui-kit.test.tsx
 * ├── scripts/copy-ui-kit-assets.ts
 * ├── src/admin/settings-schema.ts
 * ├── src/console/admin-pages-2.tsx
 * ├── src/console/ui/components.tsx
 * ├── src/console/ui/confirm.tsx
 * ├── src/console/ui/shell.tsx
 * ├── src/console/user-pages.tsx
 * ├── src/db/settings.ts
 * ├── src/setup/pages-steps.tsx
 * ├── src/setup/pages.tsx
 * ├── src/setup/token-template.ts
 * └── test/helpers/html-checks.ts
 * External: node:fs, node:module, node:os, node:path, node:vm, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";
import { copyUiKitAssets, defaultSources } from "../../scripts/copy-ui-kit-assets.ts";
import { Chip, Field, nameParts, Notice, Row, Table } from "../../src/console/ui/components.tsx";
import { SETTINGS_GROUPS, SettingsPage } from "../../src/console/admin-pages-2.tsx";
import { SETTINGS_FIELDS } from "../../src/admin/settings-schema.ts";
import { muteWords, platformWords } from "../../src/console/user-pages.tsx";
import { DEFAULT_SETTINGS } from "../../src/db/settings.ts";
import { ConfirmBody } from "../../src/console/ui/confirm.tsx";
import { renderPage, Shell } from "../../src/console/ui/shell.tsx";
import { PERMISSIONS } from "../../src/setup/token-template.ts";
import { ClaimInvalidPage, ClaimPage, DomainPage, DonePage, IdpPage, KeysPage, OrgPage, ZonePage, AccessPage } from "../../src/setup/pages-steps.tsx";
import { CodePage, LockedPage, SecretsPage, TokenPage } from "../../src/setup/pages.tsx";
import { a11yViolations, cspViolations } from "../helpers/html-checks.ts";

const page = (node: Parameters<typeof renderPage>[0]) => renderPage(node);

test("the console reveals the whole focused textarea only in a form with a pinned action row", () => {
  const handlers = new Map<string, (event: { target: unknown }) => void>();
  class Textarea {
    scrollIntoView = vi.fn();
    closest = vi.fn().mockReturnValue(null);
    constructor(readonly form: { querySelector: (selector: string) => object | null } | null) {}
  }
  const document = {
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener: (type: string, handler: (event: { target: unknown }) => void) => handlers.set(type, handler),
  };
  const script = readFileSync(new URL("../../assets/console/enhance.ts", import.meta.url), "utf8");
  runInNewContext(stripTypeScriptTypes(script), { document, HTMLTextAreaElement: Textarea, addEventListener: () => {} });
  const focus = handlers.get("focusin");
  expect(focus).toBeTypeOf("function");
  const settings = new Textarea({ querySelector: (s) => s === ".row.sticky-actions" ? {} : null });
  focus!({ target: settings });
  expect(settings.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
  const field = { scrollIntoView: vi.fn() };
  settings.closest.mockReturnValue(field);
  focus!({ target: settings });
  expect(settings.closest).toHaveBeenLastCalledWith(".field");
  expect(field.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
  expect(settings.scrollIntoView).toHaveBeenCalledTimes(1);
  for (const field of [new Textarea(null), new Textarea({ querySelector: () => null }), { scrollIntoView: vi.fn() }]) {
    focus!({ target: field });
    expect(field.scrollIntoView).not.toHaveBeenCalled();
  }
});

test("names render as escaped chips, never quoted", async () => {
  const html = await page(<Shell title="t"><p>Remove <Chip>{'<img src=x onerror=alert(1)>'}</Chip></p></Shell>);
  expect(html).toContain('<code class="chip">&lt;img src=x onerror=alert(1)&gt;</code>');
  expect(cspViolations(html)).toEqual([]);
});

test("a long name prefers to break between its parts: before a dot, after @ and -", async () => {
  expect(nameParts("ada@example.com")).toEqual(["ada@", "example", ".com"]);
  expect(nameParts("K7QF-3MZD-W2PA")).toEqual(["K7QF-", "3MZD-", "W2PA"]);
  expect(nameParts("provisioning_in_progress")).toEqual(["provisioning_in_progress"]);
  expect(nameParts(".hidden")).toEqual([".hidden"]);
  expect(nameParts("trailing-")).toEqual(["trailing-"]);
  const html = await page(<Shell title="t"><p>Remove <Chip>{"cp.example.com"}</Chip></p></Shell>);
  expect(html).toContain('<code class="chip">cp<wbr/>.example<wbr/>.com</code>');
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
  expect(html).toContain('<th role="columnheader" scope="col">a</th>');
  expect(html).toContain('<span class="sr-only">Error:</span>');
  expect(a11yViolations(html)).toEqual([]);
});

test("the confirm pattern puts Cancel first and autofocused, then the destructive button", async () => {
  const html = await page(<Shell title="t"><ConfirmBody lead="Revoke" target="laptop" consequence="gone" action="/x" cancelHref="/back" confirmLabel="Revoke" /></Shell>);
  expect(a11yViolations(html)).toEqual([]);
  expect(html.indexOf("Cancel")).toBeLessThan(html.indexOf("btn-destructive"));
  expect(html).toContain('<form method="post" action="/x"');
});

test("rows label every cell for the phone card and keep actions in one cell; the table is a captioned region", async () => {
  const H = ["Machine", "Status", "Actions"] as const;
  const html = await page(<Shell title="t"><Table caption="Machines here" headers={H}><Row headers={H} cells={["laptop", "Online", <a href="/x">Unpair…</a>]} /></Table></Shell>);
  expect(html).toContain('<td role="cell" data-label="Machine"><div class="cell-value">laptop</div></td><td role="cell" data-label="Status"><div class="cell-value">Online</div></td>');
  expect(html).toContain('<td role="cell" data-label="Actions" class="cell-actions"><div class="cell-value"><div class="row"><a href="/x">Unpair…</a></div></div></td>');
  expect(html).toContain('role="region" aria-labelledby="t-machines-here" tabindex="0"');
  expect(html).toContain('<caption id="t-machines-here">Machines here</caption>');
  expect(a11yViolations(html)).toEqual([]);
});

test("the shell prints one h1, shows the mark, and an admin page says so and links back", async () => {
  const html = await page(<Shell title="Users" orgName="Acme" context="Admin" nav={[{ href: "/console", label: "My workspace" }]} />);
  expect(html.match(/<h1>/g)).toHaveLength(1);
  expect(html).toContain('<svg class="mark"');
  expect(html).toContain('<span class="brand-org">Acme</span><span class="brand-context">Admin</span>');
  expect(await page(<Shell title="Pair" bodyHeading><h1>Pair laptop?</h1></Shell>)).not.toContain("<h1>Pair</h1>");
});

test("the shell names the signed-in account quietly, escaped, and only when it is given", async () => {
  const html = await page(<Shell title="t" signedInAs={'<b>x</b>"@example.org'} />);
  expect(html).toContain('<span class="signed-in">Signed in as <span class="name">&lt;b&gt;x&lt;/b&gt;&quot;@<wbr/>example<wbr/>.org</span></span>');
  expect(html).not.toContain("<b>x</b>");
  expect(a11yViolations(html)).toEqual([]);
  expect(await page(<Shell title="t" />)).not.toContain("signed-in");
});

test("mute counts are worded in the singular for one machine", () => {
  const none = { mute_all: false, muted_until: null };
  expect(muteWords({ ...none, muted_machine_ids: ["a"] })).toBe("1 machine muted");
  expect(muteWords({ ...none, muted_machine_ids: ["a", "b"] })).toBe("2 machines muted");
});

describe("the settings form", () => {
  test("every field sits in exactly one section", () => {
    const grouped = SETTINGS_GROUPS.flatMap((g) => g.paths);
    expect([...grouped].sort()).toEqual(SETTINGS_FIELDS.map((f) => f.path).sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });
  test("a refusal lists each bad field as a link to it, with the code apart from the sentence", async () => {
    const html = await page(SettingsPage({ orgName: "Acme", flash: null, update: null, settings: DEFAULT_SETTINGS, zoneName: "example.org", errors: [{ path: "/machine_cap_per_user", message: "must be at most 50" }] }));
    expect(html).toContain('<a href="#machine_cap_per_user">Machines per user: must be at most 50</a>');
    expect(html).toContain('id="machine_cap_per_user-error"');
    expect(html).toContain('Error code: <code class="chip">validation_failed</code>');
    expect(html.match(/<fieldset class="group">/g)).toHaveLength(SETTINGS_GROUPS.length);
    // One Save for the whole long form, pinned to the screen's bottom while it scrolls.
    expect(html.match(/Save settings/g)).toHaveLength(1);
    expect(html.match(/<form /g)).toHaveLength(1);
    expect(html).toMatch(/<div class="row sticky-actions"><button type="submit" class="btn btn-primary">Save settings<\/button><\/div><\/form>/);
    expect(a11yViolations(html)).toEqual([]);
    expect(cspViolations(html)).toEqual([]);
  });
});

const record = { step: "claim" as const, admin_email: "ada@example.org", cp_host: "cp.example.org", team_domain: "t.cloudflareaccess.com", workers_dev_disabled: false };
const SETUP_PAGES = {
  secrets: SecretsPage({ problems: ["setup_code_short", "data_key_missing"] }),
  locked: LockedPage({ reason: "failures" }),
  lockedBackstop: LockedPage({ reason: "backstop" }),
  code: CodePage({ error: "setup_code_invalid" }),
  codeDayLimit: CodePage({ error: "rate_limited", limit: "day", retryAfter: 7200 }),
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
  test("each step name is its own span, so phone width can show only the count beside the heading", async () => {
    const html = await page(SETUP_PAGES.token);
    expect(html).toContain('<li aria-current="step" class="step-current" data-total="10"><span class="step-label">API token</span></li>');
    expect(html).toContain('<h2 data-setup-step="token">API token</h2>');
  });
  test("the final page says when turning workers.dev off failed", async () => {
    expect(await page(SETUP_PAGES.done)).toContain("Turning off the workers.dev address failed");
  });
  test("long addresses in setup copy are chips that wrap between their parts, the text unchanged", async () => {
    expect(await page(SETUP_PAGES.org)).toContain('Becomes <code class="chip">&lt;team&gt;<wbr/>.cloudflareaccess<wbr/>.com</code>, the sign-in address your users see.');
    expect(await page(DonePage({ record: { ...record, workers_dev_disabled: true } }))).toContain('only <code class="chip">https://cp<wbr/>.example<wbr/>.org</code> answers from now on.');
  });
});

describe("console.css", () => {
  const css = readFileSync(new URL("../../assets/console/console.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  test("uses no colour literal, only ui-kit token variables", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color-mix)\(/i);
    expect(css).not.toMatch(/:\s*(white|black|red|green|blue|gray|grey)\b/i);
    for (const v of css.match(/var\(--[a-z0-9-]+/g) ?? []) {
      expect(["--control-h", "--gap", "--radius", "--background", "--foreground", "--card", "--card-foreground", "--primary", "--primary-foreground", "--muted-foreground", "--accent", "--border", "--input", "--ring", "--destructive", "--popover", "--popover-foreground", "--muted", "--yaran-success", "--yaran-warning", "--yaran-info"]).toContain(v.slice(4));
    }
  });
});

describe("console.css choices the council asked for", () => {
  const css = readFileSync(new URL("../../assets/console/console.css", import.meta.url), "utf8");
  test("destructive buttons put the dark background colour on the red fill, not light text", () => {
    expect(css).toMatch(/\.btn-destructive \{ background: var\(--destructive\); color: var\(--background\);/);
  });
  test("the pairing decision buttons have a misclick-safe gap, and chips wrap instead of clipping", () => {
    expect(css).toMatch(/\.actions \{[^}]*gap: 1rem 2rem;/);
    expect(css).not.toMatch(/\.chip \{[^}]*nowrap/);
    expect(css).toMatch(/\.chip \{[^}]*overflow-wrap: anywhere;/);
  });
  test("buttons grow with a long label instead of overflowing, keeping the 40px floor", () => {
    expect(css).toMatch(/\.btn \{[^}]*min-height: var\(--control-h\);[^}]*max-width: 100%;[^}]*overflow-wrap: anywhere;/);
    expect(css).not.toMatch(/\.btn \{[^}]*[^-]height: var\(--control-h\)/);
  });
  test("chips are inline so the punctuation after one never starts a line; only the fingerprint is boxed", () => {
    expect(css).toMatch(/\.chip \{ display: inline;[^}]*box-decoration-break: clone;/);
    expect(css).not.toMatch(/\.chip \{[^}]*inline-block/);
    expect(css).not.toMatch(/aria-label\]/);
    expect(css).toMatch(/\.facts \.chip-mono \{ display: inline-block;[^}]*text-wrap: balance;/);
  });
  test("a confirm chip keeps its question mark on the same line", () => {
    expect(css).toMatch(/\.chip-tail \{ white-space: nowrap; \}/);
    expect(css).toMatch(/\.chip-tail \.chip \{ white-space: normal;/);
  });
  test("one sticky action area: it reserves its height for keyboard focus, and its own buttons scroll nothing", () => {
    expect(css).toMatch(/\.sticky-actions \{ position: sticky; bottom: 0;[^}]*background: var\(--background\);/);
    expect(css).toMatch(/html:has\(\.sticky-actions\) \{ scroll-padding-bottom: 4\.5rem; \}/);
    expect(css).toMatch(/\.sticky-actions \.btn \{ scroll-margin-bottom: -4\.5rem; \}/);
  });
  test("a wrapped chip's cloned end padding stays inside its block", () => {
    expect(css).toMatch(/:is\(p, h1, dd, li, \.notice-body\):has\(\.chip\) \{ padding-inline-end: 0\.35em; \}/);
  });
  test("filter fields line up by label, and a table row's text sits on its buttons' line", () => {
    expect(css).toMatch(/\.filters > \.row:first-child \{ align-items: flex-start; \}/);
    expect(css).toMatch(/th, td \{[^}]*vertical-align: baseline; \}/);
  });
  test("phone-width tables become cards labelled from data-label", () => {
    expect(css).toMatch(/@media \(max-width: 40rem\)[\s\S]*\.table-wrap td::before \{ content: attr\(data-label\);/);
  });
  test("a phone card puts short facts in a metadata grid and gives long names and actions the full width", () => {
    expect(css).toMatch(/\.table-wrap tr \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 8rem\), 1fr\)\);/);
    expect(css).toMatch(/\.table-wrap td:first-child, \.table-wrap td:has\(\.name, \.mono\) \{ grid-column: 1 \/ -1; \}/);
    expect(css).toMatch(/\.table-wrap td\.cell-actions \{ grid-column: 1 \/ -1;/);
  });
});

test("an iOS phone is named for iPhone and iPad alike", () => {
  expect(platformWords({ platform: "ios", flavor: "appstore" } as Parameters<typeof platformWords>[0])).toBe("iOS, App Store build");
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
  const repoRoot = new URL("../../../..", import.meta.url).pathname;
  const kit = defaultSources(repoRoot);
  test.skipIf(!existsSync(kit.tokens) || !existsSync(join(repoRoot, "cloud/worker/assets/console/tokens.css")))("the built tokens.css equals packages/ui-kit/src/tokens.css", () => {
    expect(readFileSync(join(repoRoot, "cloud/worker/assets/console/tokens.css"))).toEqual(readFileSync(kit.tokens));
  });
});
