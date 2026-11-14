/**
 * Guard: tokens.css stays plain CSS.
 *
 * The Worker console imports `@yaran/ui-kit/tokens.css` without Tailwind, and the native
 * color export parses it, so Tailwind at-rules belong in theme.css only.
 *
 * - Fails on `@theme`, `@custom-variant`, `@apply`, `@source`, `@utility` or an import of tailwindcss.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:fs, vitest
 *
 * Used by: entry point (vitest, via npm test in packages/ui-kit)
 * <module-headers:end>
 */
import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8")
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "")
const TAILWIND = /@(?:theme|custom-variant|apply|source|utility|variant)\b|@import\s+["']tailwindcss/

describe("tokens.css", () => {
  it("carries no Tailwind syntax", () => {
    expect(stripComments(read("tokens.css")).match(TAILWIND)).toBeNull()
  })

  it("still declares the dark set", () => {
    expect(read("tokens.css")).toMatch(/\.dark\s*\{[^}]*--background:/)
  })

  it("is matched by the guard when Tailwind syntax does appear", () => {
    for (const bad of ["@theme inline {}", "@custom-variant dark (&:is(.dark *));", ".a { @apply p-1; }", '@import "tailwindcss";']) {
      expect(bad).toMatch(TAILWIND)
    }
    expect(stripComments(read("theme.css"))).toMatch(TAILWIND)
  })
})
