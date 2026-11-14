/**
 * @vitest-environment jsdom
 *
 * Tests for the dialog primitive.
 *
 * Pins the IME-safe Escape and the overlay's backdrop variants.
 *
 * - Runs in jsdom.
 *
 * <module-headers:begin>
 * Uses:
 * src/dialog.test.tsx
 * └── src/dialog.tsx
 * External: @testing-library/react, vitest
 *
 * Used by: entry point (vitest, via npm test in packages/ui-kit)
 * <module-headers:end>
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { Dialog, DialogContent, DialogTitle } from "./dialog"

afterEach(cleanup)

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
