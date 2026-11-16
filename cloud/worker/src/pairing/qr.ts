/**
 * The phone's add-org QR (02 §10): the `yaranapp://add-org?u=<org url>` payload as data
 * and as an SVG the consoles (07) embed.
 *
 * - The payload comes from @yaran/protocol's `addOrgUri`, the one builder the Rust (09)
 *   and web (13) renderers mirror, pinned by `fixtures/uri/add-org.json`.
 * - The org URL is the canonical `https://<control_plane_host>` from settings, never the
 *   request's Host. The SVG carries no `style=` and no script, so it fits 07's CSP.
 *
 * <module-headers:begin>
 * Uses:
 * src/pairing/qr.ts
 * └── @yaran/protocol:src/index.ts
 * External: uqr
 *
 * Used by:
 * src/pairing/qr.ts
 * ├── src/admin/pairing-service.ts
 * └── test/pairing/qr.test.ts
 * <module-headers:end>
 */
import { addOrgUri } from "@yaran/protocol";
import { renderSVG } from "uqr";

/** `yaranapp://add-org?u=…`; throws when the org URL is not an `OrgUrl`. */
export function phoneQrPayload(orgUrl: string): string {
  return addOrgUri(orgUrl);
}

/** The payload as an SVG QR code, error correction level M. */
export function phoneQrSvg(orgUrl: string): string {
  return renderSVG(phoneQrPayload(orgUrl), { ecc: "M" });
}
