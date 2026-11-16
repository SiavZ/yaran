/**
 * Tests for the native color export: the oklch conversion and the token parsing.
 *
 * Pins the OKLab math against values with a known sRGB answer, so a typo in a matrix
 * coefficient cannot ship a subtly wrong native color.
 *
 * - Neutral greys against the shadcn neutral scale's published hex values.
 * - Pure sRGB red, an in-gamut chromatic value, and alpha handling.
 *
 * <module-headers:begin>
 * Uses:
 * scripts/export-native-colors.test.mjs
 * └── scripts/export-native-colors.mjs
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in packages/ui-kit)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest"

import { androidHex, darkTokens, expectedFiles, oklchToRgb, TOKEN_NAMES } from "./export-native-colors.mjs"

const hex = (v) => androidHex(oklchToRgb(v))

describe("oklch to sRGB", () => {
  it("matches the neutral scale", () => {
    expect(hex("oklch(1 0 0)")).toBe("#FFFFFF")
    expect(hex("oklch(0 0 0)")).toBe("#000000")
    expect(hex("oklch(0.145 0 0)")).toBe("#0A0A0A")
    expect(hex("oklch(0.205 0 0)")).toBe("#171717")
    expect(hex("oklch(0.269 0 0)")).toBe("#262626")
    expect(hex("oklch(0.708 0 0)")).toBe("#A1A1A1")
    expect(hex("oklch(0.985 0 0)")).toBe("#FAFAFA")
  })

  it("lands pure red on #FF0000", () => {
    expect(hex("oklch(0.62796 0.25768 29.2339)")).toBe("#FF0000")
  })

  it("keeps alpha as the leading byte", () => {
    expect(hex("oklch(1 0 0 / 10%)")).toBe("#1AFFFFFF")
    expect(oklchToRgb("oklch(1 0 0 / 0.5)").a).toBe(0.5)
  })

  it("refuses a color it cannot convert rather than guessing", () => {
    expect(() => oklchToRgb("#c586e0")).toThrow(/unsupported color/)
  })
})

describe("the token source", () => {
  it("reads only the .dark block, ignoring comments", () => {
    const css = ":root { --background: oklch(1 0 0); }\n.dark {\n  /* --x: no; */\n  --background: oklch(0.145 0 0);\n}\n"
    expect(darkTokens(css).get("background")).toBe("oklch(0.145 0 0)")
    expect(darkTokens(css).has("x")).toBe(false)
  })

  it("produces one Android file, the catalog root and a colorset per token", () => {
    const files = [...expectedFiles().keys()]
    expect(files).toHaveLength(2 + TOKEN_NAMES.length)
    expect(files.some((f) => f.endsWith("YaranCardForeground.colorset/Contents.json"))).toBe(true)
    const xml = [...expectedFiles().values()][0]
    expect(xml.split("\n").slice(0, 2).join("\n")).toContain("@generated")
    expect(xml).toContain('<color name="yaran_card_foreground">#FAFAFA</color>')
  })
})
