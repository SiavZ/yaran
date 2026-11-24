/**
 * @vitest-environment jsdom
 *
 * Tests for the phone-or-computer width answer.
 *
 * Pins that the answer comes from the breakpoint media query, the same one the CSS reads.
 *
 * - Runs in jsdom with a stubbed matchMedia.
 */
import { renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { isMobileViewport, useIsMobile } from "./use-mobile"

function setInnerWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  })
}

function stubPhoneQuery(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(max-width: 767px)" ? matches : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  setInnerWidth(1024)
})

describe("the phone-or-computer answer", () => {
  // A phone's innerWidth follows pinch zoom and horizontal overflow, so it can
  // read 900 while the layout viewport (and every CSS breakpoint) is a phone's.
  // The answer used to come from innerWidth and painted the desktop shell.
  it("follows the media query, not an innerWidth past the breakpoint", () => {
    setInnerWidth(900)
    stubPhoneQuery(true)
    expect(isMobileViewport()).toBe(true)
    expect(renderHook(() => useIsMobile()).result.current).toBe(true)
  })

  it("reads a computer when the media query does not match", () => {
    setInnerWidth(500)
    stubPhoneQuery(false)
    expect(isMobileViewport()).toBe(false)
    expect(renderHook(() => useIsMobile()).result.current).toBe(false)
  })

  it("falls back to innerWidth where there is no matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined)
    setInnerWidth(500)
    expect(isMobileViewport()).toBe(true)
    setInnerWidth(900)
    expect(isMobileViewport()).toBe(false)
  })
})
