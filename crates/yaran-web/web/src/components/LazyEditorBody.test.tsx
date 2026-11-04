// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  vi.doUnmock("@/components/EditorBody")
  vi.resetModules()
  vi.restoreAllMocks()
})

it("defers editor loading until mounted and announces the pending load", async () => {
  const Body = vi.fn(() => <div>Editor ready</div>)
  let finish!: (module: { EditorBody: typeof Body }) => void
  const load = vi.fn(() => new Promise<{ EditorBody: typeof Body }>((resolve) => {
    finish = resolve
  }))
  vi.doMock("@/components/EditorBody", load)
  const { LazyEditorBody } = await import("./LazyEditorBody")
  expect(load).not.toHaveBeenCalled()

  const root = { kind: "agent" as const, sessionId: "s1" }
  render(<LazyEditorBody root={root} standalone />)
  expect(screen.getByRole("status").textContent).toBe("Loading editor…")
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
  await act(async () => { finish({ EditorBody: Body }) })

  expect(screen.queryByRole("status")).toBeNull()
  expect(screen.getByText("Editor ready")).toBeTruthy()
  expect(Body).toHaveBeenCalledWith({ root, standalone: true }, undefined)
})

it("keeps failed editor downloads inside the existing reload recovery", async () => {
  sessionStorage.setItem("yaran-chunk-reload", String(Date.now()))
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.doMock("@/components/EditorBody", () => Promise.reject(new Error("Chunk unavailable")))
  const { LazyEditorBody } = await import("./LazyEditorBody")

  render(<LazyEditorBody root={{ kind: "agent", sessionId: "s1" }} />)
  expect(await screen.findByRole("button", { name: "Reload" })).toBeTruthy()
  expect(screen.queryByRole("status")).toBeNull()
})
