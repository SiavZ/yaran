// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { useViewerGrid } from "./viewerGrid"

describe("useViewerGrid", () => {
  it("records the reported grid and never reconnects when a typing handover changes it", () => {
    // Whoever typed last holds the size, so the grid moves with every switch
    // of typist; the hook only records it, and has no socket to bounce.
    const view = renderHook(() => useViewerGrid())
    act(() => {
      view.result.current.noteRemoteGrid({ rows: 24, cols: 80 }, true)
      view.result.current.noteRemoteGrid({ rows: 30, cols: 100 }, false)
    })
    expect(view.result.current.remoteGrid).toEqual({ rows: 30, cols: 100 })
  })

  it("keeps its callbacks stable across renders, since the lifecycle closes over them once", () => {
    const view = renderHook(() => useViewerGrid())
    const first = view.result.current.noteRemoteGrid
    act(() => {
      view.result.current.noteLocalGrid({ rows: 24, cols: 80 })
    })
    expect(view.result.current.localGrid).toEqual({ rows: 24, cols: 80 })
    expect(view.result.current.noteRemoteGrid).toBe(first)
  })
})
