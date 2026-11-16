/**
 * `APP_CALLBACK_URLS` from `publisher.json`'s domain, the one home of that value: the
 * release's deploy tree and the source org installer both derive it here. Node built-ins
 * only, so the installer can load it before any npm tree is installed.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:fs
 *
 * Used by:
 * scripts/callback-urls.ts
 * ├── scripts/assemble-deploy-tree.ts
 * ├── scripts/org-setup/run.ts
 * └── test/node/deploy-tree.test.ts
 * <module-headers:end>
 */
import { readFileSync } from "node:fs";

/** The phone app's verified sign-in callback on the publisher domain. */
export function callbackUrls(publisherDomain: string): string {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(publisherDomain)) throw new Error(`publisher_domain is not a hostname: ${publisherDomain}`);
  return `https://${publisherDomain}/auth/callback`;
}

/** The callback from a `publisher.json`, or null while it is missing, unreadable or still the placeholder. */
export function publisherCallbacks(publisherJson: string): string | null {
  try {
    const domain = (JSON.parse(readFileSync(publisherJson, "utf8")) as { publisher_domain?: unknown }).publisher_domain;
    return typeof domain === "string" && domain !== "<publisher-domain>" ? callbackUrls(domain) : null;
  } catch {
    return null;
  }
}
