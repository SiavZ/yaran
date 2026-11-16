// @vitest-environment jsdom
// The shared primitives come from `@yaran/ui-kit`, a linked package with its own
// node_modules (for its own tests). If this build ever resolved the kit's React
// instead of ours, every kit component that calls a hook would throw an
// invalid-hook-call error the moment it rendered inside our tree. These tests
// render kit components inside the web build and pin the versions that keep the
// TypeScript side on one React too.
import { readFileSync } from "node:fs"
import { createContext, useContext, useState } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Dialog, DialogContent, DialogTitle } from "@yaran/ui-kit/dialog"
import { Button } from "@yaran/ui-kit/button"

afterEach(cleanup)

const Web = createContext("missing")

function ReadsWebContext() {
  return <p>{useContext(Web)}</p>
}

function Counter() {
  const [n, setN] = useState(0)
  return <Button onClick={() => setN(n + 1)}>clicked {n}</Button>
}

describe("the ui-kit inside the web build", () => {
  it("renders a kit Dialog, hooks and all, under the web's React", () => {
    render(
      <Web.Provider value="from the web tree">
        <Dialog open>
          <DialogContent>
            <DialogTitle>Kit dialog</DialogTitle>
            <ReadsWebContext />
            <Counter />
          </DialogContent>
        </Dialog>
      </Web.Provider>,
    )
    expect(screen.getByRole("dialog")).toBeTruthy()
    // A context created with the web's React reaches a child rendered inside
    // the kit's portal: one reconciler drove both.
    expect(screen.getByText("from the web tree")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "clicked 0" }))
    expect(screen.getByRole("button", { name: "clicked 1" })).toBeTruthy()
  })

  it("pins the kit's React and base-ui to the exact versions this package installs", () => {
    // tsconfig.app.json maps react to our copy, but every other peer the kit
    // type-checks against comes from the kit's own install, and two different
    // versions there fail `tsc -b` with "two different types with this name".
    const lock = (path: string) =>
      JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")).packages
    const web = lock("../../package-lock.json")
    const kit = lock("../../../../../packages/ui-kit/package-lock.json")
    for (const name of [
      "react",
      "react-dom",
      "@types/react",
      "@types/react-dom",
      "@base-ui/react",
      "lucide-react",
      "class-variance-authority",
      "clsx",
      "tailwind-merge",
      "sonner",
    ]) {
      const key = `node_modules/${name}`
      expect(kit[key]?.version, name).toBe(web[key]?.version)
    }
  })
})
