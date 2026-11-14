import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// Behind Cloudflare Access the manifest is fetched WITHOUT credentials unless the
// link asks for them, so Access redirects it to a login page and an installed
// app gets no manifest. `use-credentials` sends the Access cookie (same-origin).
const html = readFileSync(
  fileURLToPath(new URL("../../index.html", import.meta.url)),
  "utf8",
)

describe("index.html manifest link", () => {
  it("is exactly one link, and it sends credentials", () => {
    const links = html.match(/<link[^>]*rel="manifest"[^>]*>/g) ?? []
    expect(links).toHaveLength(1)
    expect(links[0]).toContain('crossorigin="use-credentials"')
  })
})
