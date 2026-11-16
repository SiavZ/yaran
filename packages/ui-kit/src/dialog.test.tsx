/**
 * @vitest-environment jsdom
 *
 * Tests for the dialog primitive.
 *
 * Pins the IME-safe Escape, the browser's Back reaching an open dialog through
 * the modal registry, and the overlay's backdrop variants.
 *
 * - Runs in jsdom.
 *
 * <module-headers:begin>
 * Uses:
 * src/dialog.test.tsx
 * └── src/dialog.tsx
 * External: @testing-library/react, react, vitest
 *
 * Used by: entry point (vitest, via npm test in packages/ui-kit)
 * <module-headers:end>
 */
import { useRef, useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "./dialog"
import { closeModals, openModals } from "./modalHistory"

// The web's store gives every registered modal a history entry and, on the
// browser's Back, closes the newest one through `closeModals`. The kit has no
// store, so these tests stand in for it: an entry is a registration, and Back is
// that close. The store's own half is pinned in the web's suite.
function back(): void {
  const newest = openModals().at(-1)
  if (newest) closeModals([newest.id])
}

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
    const before = openModals().length
    fireEvent.click(screen.getByText("open"))
    await screen.findByText("Plain")
    await waitFor(() => {
      expect(openModals().length).toBe(before + 1)
    })
    act(() => back())
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
    const before = openModals().length
    render(<Busy />)
    await screen.findByText("Saving")
    await waitFor(() => {
      expect(openModals().length).toBe(before + 1)
    })
    act(() => back())
    expect(screen.getByText("Saving")).toBeTruthy()
    fireEvent.click(screen.getByText("finish"))
    await waitFor(() => {
      expect(screen.queryByText("Saving")).toBeNull()
    })
  })
})

function overlay() {
  return document.querySelector('[data-slot="dialog-overlay"]')
}

describe("DialogContent destructive backdrop", () => {
  it.each([{ isComposing: true }, { keyCode: 229 }])("keeps the form open when Escape cancels IME composition: %o", (composition) => {
    const onOpenChange = vi.fn()
    render(<Dialog open onOpenChange={onOpenChange}><DialogContent><DialogTitle>Form</DialogTitle><input aria-label="Name" /></DialogContent></Dialog>)
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Escape", ...composition })
    expect(onOpenChange).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Escape" })
    expect(onOpenChange).toHaveBeenCalled()
  })

  it("keeps the modest blur on every overlay", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Plain</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    const el = overlay()
    expect(el).not.toBeNull()
    expect(el?.className).toContain(
      "supports-backdrop-filter:backdrop-blur-sm",
    )
  })

  it("does NOT add backdrop-grayscale without the destructive prop", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Plain</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    expect(overlay()?.className).not.toContain("backdrop-grayscale")
  })

  it("adds backdrop-grayscale when destructive is set", () => {
    render(
      <Dialog open>
        <DialogContent destructive>
          <DialogTitle>Danger</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    const el = overlay()
    expect(el?.className).toContain("backdrop-grayscale")
    // blur stays on the base overlay for the destructive variant too
    expect(el?.className).toContain(
      "supports-backdrop-filter:backdrop-blur-sm",
    )
  })

  it("does not spread the destructive prop onto the popup element", () => {
    render(
      <Dialog open>
        <DialogContent destructive>
          <DialogTitle>Danger</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    const popup = document.querySelector('[data-slot="dialog-content"]')
    expect(popup).not.toBeNull()
    expect(popup?.getAttribute("destructive")).toBeNull()
  })
})
