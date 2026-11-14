import { describe, expect, it } from "vitest"

import { describeErrorBody, ERROR_BODY_MAX_CHARS } from "./httpBody"

describe("describeErrorBody", () => {
  it("replaces an HTML body with a sentence that names the likely cause", () => {
    for (const [type, body] of [
      ["text/html; charset=utf-8", "Sign in"],
      ["", "  <!doctype html><html>…</html>"],
    ]) {
      const msg = describeErrorBody(403, type, body)
      expect(msg).toContain("HTTP 403 with a web page")
      expect(msg).toContain("Cloudflare Access")
      expect(msg).not.toContain("<")
    }
  })

  it("caps a long plain body by code points, keeping an emoji at the boundary whole", () => {
    const body = "a".repeat(ERROR_BODY_MAX_CHARS - 2) + "😀😀" + "b".repeat(2000)
    const msg = describeErrorBody(500, "text/plain", body)!
    expect(Array.from(msg)).toHaveLength(ERROR_BODY_MAX_CHARS)
    expect(msg.endsWith("😀…")).toBe(true)
    expect(msg).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  it("keeps a short body and says nothing for an empty one", () => {
    expect(describeErrorBody(409, "text/plain", " branch exists \n")).toBe("branch exists")
    expect(describeErrorBody(500, "text/plain", "   ")).toBeNull()
  })
})
