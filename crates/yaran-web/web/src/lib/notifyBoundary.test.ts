import { readFileSync, readdirSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

// The import boundary that makes the notification policy stick.
//
// `lib/notify.ts` owns the severity-graded window, the `0` opt-out, `sticky`,
// and the busy leak guard. None of that reaches the user from a module that
// imports sonner directly: sonner's own default is a flat 4 seconds for every
// tone, which is a quarter of the documented error window and ignores the
// user's `ui.status_clear_seconds` entirely.
//
// This is asserted as an EXACT set rather than "the raiser is used somewhere",
// because the weaker version was already tried and lost. `lib/finalToast.ts`
// carried a doc comment naming itself "the one way to raise a FINAL toast"
// while 91 call sites across ten files imported sonner and ignored it, 78 of
// them errors shown for 4 seconds. Nothing failed, so nothing stopped it. With
// an exact set, a new importer cannot appear without someone adding its name
// here and defending it in review.
//
// This is the same idiom as the TUI's `KNOWN_DUAL_MODE_VIOLATIONS`: a named
// list asserted as an exact set, not a subset.
//
// WHAT IT IS NOT. This catches an ACCIDENT, not an evasion, and saying so
// matters because a check that reads like a guarantee gets trusted like one. It
// greps text; it does not parse TypeScript. Concretely:
//
//   - `stripComments` below has no string or template awareness, so a `//`
//     inside a string literal deletes the rest of that PHYSICAL LINE. That can
//     hide a real import as easily as it can raise a false one.
//   - the pattern knows two spellings, a `from` clause and an `import()` call
//     with a literal. It does not know `require`, a bare side-effect import, a
//     dynamic import built from a template literal or a variable, or a
//     re-export laundering the module through a third file.
//
// None of those is a plausible way for somebody to reach for a toast in a
// hurry, which is the failure this exists to catch: 91 call sites that each
// typed the obvious import. Anyone determined to get around it can, and the
// answer to that is review, not a cleverer regex.

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..")

// The shared primitives moved to `packages/ui-kit`, outside this tree, yet they
// ship in this bundle, so the boundary scans the kit's source too. Its files are
// named `@yaran/ui-kit/<file>`, the way the web imports them; the web's own
// files keep their `src/`-relative names. Read from the repository path rather
// than through node_modules, so the scan does not depend on how npm linked it.
const KIT = join(SRC, "../../../../packages/ui-kit/src")
const KIT_PREFIX = "@yaran/ui-kit/"

/// The only PRODUCTION modules that may import sonner.
///
/// `lib/notify.ts` is the raiser. The kit's `sonner.tsx` is the Toaster
/// component itself, which imports the React component and its types, never the
/// raiser. There is no third entry, and adding one is the thing this test
/// exists to stop.
const SONNER_IMPORTERS = [`${KIT_PREFIX}sonner.tsx`, "lib/notify.ts"]

/// Tests that reach sonner directly, each for a stated reason.
///
/// Every one of these MOCKS sonner and reads the spy: sonner is their assertion
/// surface, the far end of the pipe, not a way to raise a toast. That is a
/// legitimate thing for a test to do (it is what proves the migrated call sites
/// now carry yaran's durations), but the list is exact all the same, because a
/// spy installed on sonner from a test covering some module that has no
/// business notifying at all is worth a second look.
///
/// The one exception to the mocking rule is the kit's `sonner.test.tsx`,
/// which renders the real Toaster and pins sonner's actual behavior.
// Kept sorted, because the scan is.
const SONNER_TEST_IMPORTERS = [
  // Mounts the real Toaster and pins sonner's loading-toast limitations, so it
  // has to raise through sonner to have anything to look at. It runs in the kit.
  `${KIT_PREFIX}sonner.test.tsx`,
  // The drop-report and clipboard journeys: they assert which tone, id and
  // duration each report ends up with.
  "components/TerminalPane.clipboard.test.tsx",
  "components/TerminalPane.filedrop.test.tsx",
  // The favicon migration notice.
  "lib/favicon.dom.test.tsx",
  "lib/favicon.test.ts",
  // The raiser's own test: it installs the sonner spy that every assertion in
  // it reads. This is the module under test's dependency, not a bypass.
  "lib/notify.test.ts",
  // The store's REST-error, macro and engine-status toast routing.
  "lib/restActionsStore.test.ts",
  "lib/storeMacros.test.ts",
  "lib/storeStatusToasts.test.ts",
]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full))
      continue
    }
    if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

// Matches a static import's `from` clause and a dynamic `import()` call alike.
// A `vi.mock` by module name is deliberately NOT a match: it installs a spy
// under `notify`'s own import and is how most of the suite observes toasts
// without importing anything.
const IMPORTS_SONNER = /(?:from\s*|import\s*\(\s*)["']sonner["']/

// Comments are stripped before matching, or this file's own prose about the
// thing it is looking for counts as an occurrence of it, and so does every
// store test whose header explains which import its mock is standing in for.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
}

function importersIn(root: string, prefix: string): string[] {
  return sourceFiles(root)
    .filter((file) => IMPORTS_SONNER.test(stripComments(readFileSync(file, "utf8"))))
    .map((file) => prefix + relative(root, file).split(sep).join("/"))
}

function importersOfSonner(): string[] {
  return [...importersIn(SRC, ""), ...importersIn(KIT, KIT_PREFIX)].sort()
}

const isTest = (path: string) => /\.test\.tsx?$/.test(path)

describe("the sonner import boundary", () => {
  it("lets exactly two production modules import sonner", () => {
    expect(importersOfSonner().filter((p) => !isTest(p))).toEqual(SONNER_IMPORTERS)
  })

  it("lets exactly the named tests import sonner", () => {
    expect(importersOfSonner().filter(isTest)).toEqual(SONNER_TEST_IMPORTERS)
  })

  it("actually reads files, so an empty scan can never pass by accident", () => {
    // Without this, a broken walk (wrong root, wrong extension filter) returns
    // nothing, both assertions above go green on empty arrays, and the boundary
    // is unguarded while looking guarded.
    expect(sourceFiles(SRC).length).toBeGreaterThan(100)
    expect(sourceFiles(KIT).length).toBeGreaterThan(10)
    expect(importersOfSonner().length).toBe(
      SONNER_IMPORTERS.length + SONNER_TEST_IMPORTERS.length,
    )
  })
})
