// A warning is painted in the theme's `yaran-warning` token, never in a Tailwind
// palette amber or yellow, so the tone lives in one place, the shared kit's theme. The
// amber STATE colors (a detached agent, a connection still being made, a
// modified file) are not warnings, and each has a semantic token of its own for
// the same reason. This guard reads every source file under components/ and
// lib/ and fails on a palette amber or yellow utility outside the allowlist
// below, which carries a reason for every entry. The green and red state
// colors (working, active, added and deleted lines, a pull request's state,
// success and failure) and a merged pull request's purple are tokens for the
// same reason, so a palette green, red, emerald, rose, purple, violet or fuchsia
// utility class written out in any source file under src/ fails too, with no
// exceptions. Both checks match literal palette class names
// only: a hex or arbitrary value, or a class assembled at runtime, gets past
// them. Each state token must also be defined in the shared kit's theme (its
// `tokens.css` values and its `theme.css` mapping) and used where it belongs,
// because Tailwind emits nothing for a class naming an undefined token and the
// color would vanish without an error. The kit's primitives are scanned too: a
// moved primitive must not carry a palette color the web would refuse.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const srcDir = fileURLToPath(new URL("../", import.meta.url))
// The shared kit the primitives moved into; a `kit:` name below is a file there.
const kitDir = fileURLToPath(new URL("../../../../../packages/ui-kit/src/", import.meta.url))

function sourceOf(name: string): string {
  return name.startsWith("kit:")
    ? readFileSync(join(kitDir, name.slice("kit:".length)), "utf-8")
    : readFileSync(join(srcDir, name), "utf-8")
}

// The theme as the kit defines it: the token values and their Tailwind mapping.
function themeCss(): string {
  return ["tokens.css", "theme.css"]
    .map((file) => readFileSync(join(kitDir, file), "utf-8"))
    .join("\n")
}

// Every source file the guard reads, by the name it reports.
function sources(dirs: string[]): { name: string; path: string }[] {
  return dirs.flatMap((dir) =>
    walk(dir).map((path) => ({
      path,
      name: path.startsWith(kitDir) ? `kit:${relative(kitDir, path)}` : relative(srcDir, path),
    })),
  )
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

const PALETTE_AMBER = /\b[a-z-]+-(?:amber|yellow)-\d{2,3}\b/g
const PALETTE_STATE = /\b[a-z-]+-(?:green|red|emerald|rose|purple|violet|fuchsia)-\d{2,3}\b/g

// File and exact class, with why it cannot be a token.
const ALLOWED: Record<string, { classes: string[]; why: string }> = {}

// The state tokens, each with the class that paints it in each file that must
// use it.
const STATE_TOKENS: { token: string; uses: Record<string, string> }[] = [
  {
    token: "yaran-detached",
    uses: {
      "components/StatusBadge.tsx": "text-yaran-detached",
      "lib/agentRow.ts": "text-yaran-detached",
      "lib/flatList.ts": "text-yaran-detached",
    },
  },
  {
    token: "yaran-connecting",
    uses: { "components/ConnDot.tsx": "bg-yaran-connecting" },
  },
  {
    token: "yaran-git-modified",
    uses: { "components/FileStatusIcon.tsx": "text-yaran-git-modified" },
  },
  {
    token: "yaran-working",
    uses: {
      "lib/flatList.ts": "text-yaran-working",
      "lib/flatTerminals.ts": "text-yaran-working",
    },
  },
  {
    token: "yaran-active",
    uses: {
      "components/StatusBadge.tsx": "text-yaran-active",
      "lib/agentRow.ts": "text-yaran-active",
    },
  },
  {
    token: "yaran-added",
    uses: {
      "components/ChangedFiles.tsx": "text-yaran-added",
      "components/FileStatusIcon.tsx": "text-yaran-added",
    },
  },
  {
    token: "yaran-deleted",
    uses: {
      "components/ChangedFiles.tsx": "text-yaran-deleted",
      "components/FileStatusIcon.tsx": "text-yaran-deleted",
    },
  },
  {
    token: "yaran-success",
    uses: {
      "components/ConnDot.tsx": "bg-yaran-success",
      "kit:sonner.tsx": "text-yaran-success",
    },
  },
  { token: "yaran-info", uses: { "kit:sonner.tsx": "text-yaran-info" } },
  {
    token: "yaran-error",
    uses: { "components/ConnDot.tsx": "bg-yaran-error" },
  },
  { token: "yaran-pr-open", uses: { "lib/pr.ts": "text-yaran-pr-open" } },
  { token: "yaran-pr-open-hover", uses: { "lib/pr.ts": "hover:text-yaran-pr-open-hover" } },
  { token: "yaran-pr-open-tint", uses: { "lib/pr.ts": "bg-yaran-pr-open-tint/10" } },
  { token: "yaran-pr-merged", uses: { "lib/pr.ts": "text-yaran-pr-merged" } },
  { token: "yaran-pr-merged-hover", uses: { "lib/pr.ts": "hover:text-yaran-pr-merged-hover" } },
  { token: "yaran-pr-merged-tint", uses: { "lib/pr.ts": "bg-yaran-pr-merged-tint/10" } },
  { token: "yaran-pr-closed", uses: { "lib/pr.ts": "text-yaran-pr-closed" } },
  { token: "yaran-pr-closed-hover", uses: { "lib/pr.ts": "hover:text-yaran-pr-closed-hover" } },
  { token: "yaran-pr-closed-tint", uses: { "lib/pr.ts": "bg-yaran-pr-closed-tint/10" } },
]

describe("warning tone", () => {
  it("defines the yaran-warning token in the theme", () => {
    const css = themeCss()
    expect(css).toMatch(/--color-yaran-warning:\s*var\(--yaran-warning\)/)
    expect(css.match(/--yaran-warning:/g)?.length).toBe(2)
  })

  it("paints warnings with the token, never a palette amber or yellow", () => {
    const offenders: string[] = []
    for (const { name, path } of sources([
      join(srcDir, "components"),
      join(srcDir, "lib"),
      kitDir,
    ])) {
      if (!/\.tsx?$/.test(name) || name.includes(".test.")) continue
      const source = readFileSync(path, "utf-8")
      const allowed = ALLOWED[name]?.classes ?? []
      for (const match of source.matchAll(PALETTE_AMBER)) {
        if (!allowed.includes(match[0])) offenders.push(`${name}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("paints green, red and purple states with tokens, never a palette class", () => {
    const offenders: string[] = []
    for (const { name, path } of sources([srcDir, kitDir])) {
      if (!/\.tsx?$/.test(name) || name.includes(".test.")) continue
      const source = readFileSync(path, "utf-8")
      for (const match of source.matchAll(PALETTE_STATE)) {
        offenders.push(`${name}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it.each(STATE_TOKENS)("defines the $token state token in the theme", ({ token }) => {
    const css = themeCss()
    expect(css).toMatch(new RegExp(`--color-${token}:\\s*var\\(--${token}\\)`))
    expect(css.match(new RegExp(`--${token}:`, "g"))?.length).toBe(2)
  })

  it.each(STATE_TOKENS)("paints the $token state with its token", ({ uses }) => {
    for (const [name, cls] of Object.entries(uses)) {
      expect(sourceOf(name), name).toContain(cls)
    }
  })

  it.each([
    "components/RenameSessionDialog.tsx",
    "components/AddProjectDialog.tsx",
    "components/AgentInfoDialog.tsx",
  ])("%s paints its warning with the token", (name) => {
    const source = readFileSync(join(srcDir, name), "utf-8")
    expect(source).toContain("text-yaran-warning")
  })
})
