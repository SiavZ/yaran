// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"

import { agentRoot } from "@/lib/editorRoot"

// The loaded directories are what a revisit (window focus, the page becoming
// visible) refetches. Reported from a passive effect, they lagged the commit
// that painted them, and a focus event landing in that gap read an empty list
// and refreshed nothing: the editor's "walks the search index once for a
// revisit" case failed on a loaded CI runner exactly that way.

vi.mock("@/hooks/use-coarse-pointer", () => ({ useIsCoarsePointer: () => false }))
vi.mock("@/lib/fileApi", () => ({
  fileApi: {
    tree: async (_sid: string, dir: string) => ({
      dir,
      entries:
        dir === ""
          ? [
              {
                name: "notes.md",
                path: "notes.md",
                is_dir: false,
                is_symlink: false,
                expandable: false,
              },
            ]
          : [],
    }),
  },
}))
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const { FileTree } = await import("./FileTree")

afterEach(cleanup)

it("reports a directory as loaded in the same commit that paints its listing", async () => {
  const reported: string[][] = []
  // What the caller's ref held when the listing first became visible, read
  // from a mutation observer: a microtask after the commit, which is before
  // any passive effect of a non-urgent render has had a chance to run.
  let reportedWhenPainted: string[] | null = null
  const observer = new MutationObserver(() => {
    if (reportedWhenPainted !== null || !screen.queryByText("notes.md")) return
    reportedWhenPainted = reported.at(-1) ?? []
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  })

  render(
    <FileTree
      root={agentRoot("s1")}
      openPath={null}
      changed={new Map()}
      initialPath={null}
      onOpen={() => {}}
      onLoadedDirsChange={(dirs) => reported.push(dirs)}
    />,
  )
  await waitFor(() => expect(reportedWhenPainted).not.toBeNull())
  observer.disconnect()

  expect(reportedWhenPainted).toEqual([""])
})
