// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, renderHook, waitFor } from "@testing-library/react"

const get = vi.fn()
vi.mock("./boardApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./boardApi")>()
  return { ...actual, boardApi: { get: () => get() } }
})

const { useBoardWaiting } = await import("./useBoardWaiting")

function card(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "task",
    title: "t",
    created_at: "2026-11-19T00:00:00Z",
    updated_at: "2026-11-19T00:00:00Z",
    label: `#${id}`,
    waiting: false,
    reply_agent: null,
    ...over,
  }
}

afterEach(() => cleanup())

describe("useBoardWaiting", () => {
  it("counts the open cards in my queue that wait on a person", async () => {
    get.mockResolvedValue({
      people: ["Sam", "Alex"],
      me: "Sam",
      problems: [],
      cards: [
        card(1),
        card(2, { assignee: "Alex" }),
        card(3, { kind: "info" }),
        card(4, { resolved_at: "2026-11-19T01:00:00Z" }),
      ],
    })
    const { result } = renderHook(() => useBoardWaiting())
    await waitFor(() => expect(result.current).toBe(1))
  })

  it("stays unknown when the board cannot be read", async () => {
    get.mockRejectedValue(new Error("offline"))
    const { result } = renderHook(() => useBoardWaiting())
    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(result.current).toBeNull()
  })
})
