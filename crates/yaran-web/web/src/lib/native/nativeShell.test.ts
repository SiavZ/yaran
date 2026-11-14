/**
 * Tests for nativeShell.ts: Phase 02's shared UA fixture plus the page-level cases.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/native/nativeShell.test.ts
 * └── src/lib/native/nativeShell.ts
 * External: node:fs, node:path, node:url, vitest
 *
 * Used by: entry point (vitest, via npm test in crates/yaran-web/web)
 * <module-headers:end>
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  isNativeShell,
  nativeShell,
  parseNativeShell,
  resetNativeShellForTest,
} from "./nativeShell"

const fixture = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../../../cloud/protocol/fixtures/ua/ua.json",
    ),
    "utf8",
  ),
) as { parse: { ua: string; expect: unknown }[] }

const SAFARI_IPAD_APP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) YaranApp/1.2.0 (ios; tablet)"

describe("parseNativeShell", () => {
  it.each(fixture.parse)("matches Phase 02's fixture for $ua", ({ ua, expect: want }) => {
    expect(parseNativeShell(ua)).toEqual(want)
  })

  it.each([
    ["android", "phone"],
    ["android", "tablet"],
    ["ios", "phone"],
    ["ios", "tablet"],
  ])("accepts %s %s", (os, form) => {
    expect(parseNativeShell(`YaranApp/1.2.0 (${os}; ${form})`)).toEqual({
      version: "1.2.0",
      os,
      form,
    })
  })

  it("rejects a four-part version, as Phase 02's grammar does", () => {
    expect(parseNativeShell("YaranApp/1.2.0.4 (ios; phone)")).toBeNull()
  })

  it("rejects malformed and injected tokens", () => {
    expect(parseNativeShell("YaranApp/1.2.0 ((ios; phone))")).toBeNull()
    expect(parseNativeShell("YaranApp/1.2.0 (ios; phone; tablet)")).toBeNull()
    expect(parseNativeShell("YaranApp/1.2.0 (symbian; phone)")).toBeNull()
    expect(parseNativeShell("YaranApp/1.2.0 (ios; watch)")).toBeNull()
    expect(parseNativeShell("")).toBeNull()
    expect(parseNativeShell(null)).toBeNull()
  })

  it("finds the token in the middle of a WebView UA", () => {
    expect(
      parseNativeShell(`Mozilla/5.0 (iPad) YaranApp/1.2.0 (ios; tablet) Mobile/15E148`)?.form,
    ).toBe("tablet")
  })
})

describe("nativeShell", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetNativeShellForTest()
  })

  it("is false in an ordinary browser", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0" })
    resetNativeShellForTest()
    expect(isNativeShell()).toBe(false)
  })

  it("is true inside the app and memoises the first read", () => {
    vi.stubGlobal("navigator", { userAgent: SAFARI_IPAD_APP })
    resetNativeShellForTest()
    expect(nativeShell()?.os).toBe("ios")
    vi.stubGlobal("navigator", { userAgent: "Firefox/121.0" })
    expect(isNativeShell()).toBe(true)
  })
})
