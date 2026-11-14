/**
 * Cloud docs domain guard: the Cloud Connect pages name no invented hostname.
 *
 * yaran has no deployed domain of its own, and an org's control plane, its zone
 * and the publisher's relay and callback domain are values someone else supplies.
 * So the Cloud Connect pages may name only real, verified origins (the allowlist
 * below, each with its reason) or placeholders written with angle brackets, such
 * as `<org-control-plane>`. A plausible-looking `cp.example.com` in a docs page
 * is exactly the mistake this exists to stop.
 *
 * - Reads `website/docs/cloud*.md`, `mobile-apps.md` and `push-notifications.md`.
 * - Checks an inline bad page, so the guard is proven to fail as well as pass.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:fs, node:path, vitest
 *
 * Used by: entry point (vitest, via npm test in website and website-ci.yml)
 * <module-headers:end>
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const docsDir = resolve(process.cwd(), "docs");

// Each entry is a real origin the pages are allowed to name, and why it is real.
const ALLOWED_HOSTS: Record<string, string> = {
  // The canonical repository (CLAUDE.md product identity); only under /SiavZ/yaran.
  "github.com": "the yaran repository, releases and SECURITY.md",
  // Cloudflare's own dashboard, where admins create tokens and Zero Trust orgs.
  "dash.cloudflare.com": "Cloudflare dashboard",
  // Cloudflare's product documentation.
  "developers.cloudflare.com": "Cloudflare docs",
  // The F-Droid store, one of the four install channels.
  "f-droid.org": "F-Droid store",
  // UnifiedPush's own site, which lists the distributors.
  "unifiedpush.org": "UnifiedPush distributor list",
  // ntfy, the example UnifiedPush distributor.
  "ntfy.sh": "ntfy distributor",
  // The two app stores.
  "play.google.com": "Google Play",
  "apps.apple.com": "App Store",
  // Cloudflare's Workers domain, named as a product; any host under it must be a placeholder.
  "workers.dev": "the bare name of Cloudflare's Workers domain",
};

// Hosts the GitHub entry is allowed to point at.
const GITHUB_PATH = /^\/SiavZ\/yaran(?:[/#?]|$)/;

// shortcut: bare-word detection only knows these TLDs, and leaves out `sh` because
// `install.sh` is a file name. Grow the list when a page needs a new TLD; URLs are
// checked whatever their TLD.
const BARE_TLDS =
  "com|net|org|io|dev|app|ai|cloud|co|me|xyz|page|link|site|tech|info|biz|us|uk|eu|de|fi";

const URL_RE = /\bhttps?:\/\/([^\s/)\]>`"']+)([^\s)\]`"']*)/g;
const BARE_RE = new RegExp(
  `(?<![\\w./-])((?:[a-z0-9<>_-]+\\.)+(?:${BARE_TLDS}))(?![\\w-])(\\/[^\\s)\\]\`"']*)?`,
  "gi",
);

/** Every hostname a page names that is neither allowlisted nor a placeholder. */
export function unknownHosts(text: string): string[] {
  const bad: string[] = [];
  const check = (host: string, path: string) => {
    const h = host.toLowerCase().replace(/:\d+$/, "");
    if (h.includes("<")) return; // a placeholder such as <org-control-plane>
    if (h === "127.0.0.1" || h === "localhost") return;
    if (!(h in ALLOWED_HOSTS)) {
      bad.push(h);
      return;
    }
    if (h === "github.com" && !GITHUB_PATH.test(path)) bad.push(`${h}${path}`);
  };
  for (const m of text.matchAll(URL_RE)) check(m[1], m[2] ?? "");
  const withoutUrls = text.replace(URL_RE, " ");
  for (const m of withoutUrls.matchAll(BARE_RE)) check(m[1], m[2] ?? "");
  return bad;
}

const cloudPages = readdirSync(docsDir)
  .filter(
    (name) =>
      (name.startsWith("cloud") && name.endsWith(".md")) ||
      name === "mobile-apps.md" ||
      name === "push-notifications.md",
  )
  .sort();

describe("Cloud Connect docs name only real origins or placeholders", () => {
  it("finds the pages", () => {
    expect(cloudPages.length).toBeGreaterThanOrEqual(7);
  });

  for (const name of cloudPages) {
    it(name, () => {
      expect(unknownHosts(readFileSync(resolve(docsDir, name), "utf8"))).toEqual([]);
    });
  }

  it("fails on a page that invents hostnames", () => {
    const badPage = [
      "Open https://cp.example.com/setup to begin.",
      "Your machine lives at laptop-alice.acme.dev.",
      "Deploy from https://github.com/someone-else/yaran.",
      "The setup page is on yaran-cp.acme.workers.dev until it closes.",
    ].join("\n");
    expect(unknownHosts(badPage)).toEqual([
      "cp.example.com",
      "github.com/someone-else/yaran.",
      "laptop-alice.acme.dev",
      "yaran-cp.acme.workers.dev",
    ]);
  });

  it("accepts placeholders, allowlisted origins and file names", () => {
    const goodPage = [
      "Run `yaran cloud login https://<org-control-plane>`.",
      "Its address is `<machine>-<user>.<zone>`, and setup starts on",
      "`<worker>.<account>.workers.dev`, the bare `workers.dev` address.",
      "See https://github.com/SiavZ/yaran/releases and [ntfy](https://ntfy.sh).",
      "Edit config.toml, run install.sh, read credentials.json.",
    ].join("\n");
    expect(unknownHosts(goodPage)).toEqual([]);
  });
});
