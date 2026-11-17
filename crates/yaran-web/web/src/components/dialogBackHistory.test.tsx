// @vitest-environment jsdom
//
// The kit's dialog registers with the kit's modal registry, and the web's store
// gives each registered modal a history entry and closes it on the browser's
// Back. This pins the two halves together across the package boundary (one
// registry, not a copy per package), with the real store over a real history.
import { useRef, useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@yaran/ui-kit/dialog"
import { installBrowserHistory } from "@/test/browserHistory"

// The browser's Back reaches a dialog through the store, which gives every open
// dialog a history entry of its own, so the real store is loaded over a
// history that has one.
const browser = installBrowserHistory()
vi.stubGlobal(
  "fetch",
  vi.fn(() => Promise.reject(new Error("offline test"))),
)
await import("@/lib/store")

afterEach(cleanup)

describe("the browser's Back", () => {
  // A dialog nobody controls keeps its open state inside base-ui, so this is
  // the case where the primitive has to know it is open by itself.
  it("closes a dialog opened from its own trigger", async () => {
    render(
      <Dialog>
        <DialogTrigger>open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Plain</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    const before = browser.index
    fireEvent.click(screen.getByText("open"))
    await screen.findByText("Plain")
    await waitFor(() => {
      expect(browser.index).toBe(before + 1)
    })
    act(() => browser.back())
    await waitFor(() => {
      expect(screen.queryByText("Plain")).toBeNull()
    })
  })

  // A dialog that is busy refuses to close, the way Settings does while a
  // write is in flight. The Back still counts: the dialog closes as soon as it
  // is free to.
  it("closes a busy dialog once it is no longer busy", async () => {
    function Busy() {
      const [open, setOpen] = useState(true)
      const busyRef = useRef(true)
      const [, setBusy] = useState(true)
      return (
        <Dialog
          open={open}
          onOpenChange={(next) => {
            if (!next && !busyRef.current) setOpen(false)
          }}
        >
          <DialogContent>
            <DialogTitle>Saving</DialogTitle>
            <button
              type="button"
              onClick={() => {
                busyRef.current = false
                setBusy(false)
              }}
            >
              finish
            </button>
          </DialogContent>
        </Dialog>
      )
    }
    const before = browser.index
    render(<Busy />)
    await screen.findByText("Saving")
    await waitFor(() => {
      expect(browser.index).toBe(before + 1)
    })
    act(() => browser.back())
    expect(screen.getByText("Saving")).toBeTruthy()
    fireEvent.click(screen.getByText("finish"))
    await waitFor(() => {
      expect(screen.queryByText("Saving")).toBeNull()
    })
  })
})
