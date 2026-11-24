// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"

import { writeInputWithLandingEffects, xtermScrollbarWidth } from "./constants"
import type { Terminal } from "@xterm/xterm"
import type { PtySocket } from "@/lib/ptySocket"

it("compose and accessory writes land at the visible flow prompt and clear only its stale selection", () => {
  const pane = document.createElement("div")
  pane.setAttribute("data-terminal-pane", "")
  const element = document.createElement("div")
  const flow = document.createElement("div")
  flow.setAttribute("data-terminal-flow", "")
  flow.textContent = "selected history"
  pane.append(element, flow)
  document.body.append(pane)
  Object.defineProperty(flow, "scrollHeight", { value: 1200 })
  const term = { element, scrollToBottom: vi.fn(), clearSelection: vi.fn() } as unknown as Terminal
  const pty = { sendInput: vi.fn() } as unknown as PtySocket
  const selection = document.getSelection()!
  const range = document.createRange()
  range.selectNodeContents(flow)
  selection.addRange(range)
  try {
    const bytes = new TextEncoder().encode("hello")
    writeInputWithLandingEffects(term, pty, bytes)
    expect(flow.scrollTop).toBe(1200)
    expect(selection.isCollapsed).toBe(true)
    expect(pty.sendInput).toHaveBeenCalledWith(bytes)
    expect(term.scrollToBottom).toHaveBeenCalledOnce()
  } finally {
    selection.removeAllRanges()
    pane.remove()
  }
})

// The one behavior worth pinning here is the fallback boundary: 8 is for a
// variable that is MISSING or unparsable, never for one that says 0. The old
// `|| 8` read an explicit 0 (a deliberately hidden scrollbar) as unset and
// re-reserved a gutter nothing was drawn in.
describe("xtermScrollbarWidth", () => {
  const stubVar = (value: string) => {
    vi.stubGlobal(
      "getComputedStyle",
      vi.fn(() => ({ getPropertyValue: () => value })),
    )
  }
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("honors an explicit 0 instead of falling back to 8", () => {
    stubVar("0")
    expect(xtermScrollbarWidth()).toBe(0)
  })

  it("reads an ordinary pixel value", () => {
    stubVar("12px")
    expect(xtermScrollbarWidth()).toBe(12)
  })

  it("falls back to 8 only when the variable is missing or unparsable", () => {
    stubVar("")
    expect(xtermScrollbarWidth()).toBe(8)
    stubVar("thin")
    expect(xtermScrollbarWidth()).toBe(8)
  })
})
