// @vitest-environment jsdom
// TL;DR freshness, refreshes and failures on the shared phone/desktop card view.
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { BoardCard } from "@/lib/boardApi"
import { boardApi } from "@/lib/boardApi"
import { BoardCardSummary } from "./BoardCardSummary"

const card: BoardCard = {
  id: 1, kind: "task", title: "Ship the fix", label: "#1", waiting: false,
  created_at: "2026-11-25T00:00:00Z", updated_at: "2026-11-25T00:00:00Z",
  reply_agent: "Fixer", summary_agent: "Fixer", summary_revision: "v2",
  summary_current: false,
  summary: { text: "Approved. Waiting for green CI.", revision: "v1", at: "2026-11-25T00:00:00Z" },
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe("BoardCardSummary", () => {
  it("shows a current summary without requesting work", () => {
    const request = vi.spyOn(boardApi, "requestSummary")
    render(<BoardCardSummary card={{ ...card, summary_current: true }} busy={false} />)
    expect(screen.getByRole("region", { name: "TL;DR" }).textContent).toContain(card.summary!.text)
    expect(screen.getByText(/Up to date/)).toBeTruthy()
    expect(request).not.toHaveBeenCalled()
  })

  it("labels old text and refreshes once per content revision, then shows the updated TL;DR", async () => {
    const request = vi.spyOn(boardApi, "requestSummary").mockResolvedValue({ requested: true })
    const { rerender } = render(<BoardCardSummary card={card} busy={false} />)
    expect(screen.getByText("Needs updating")).toBeTruthy()
    expect(screen.getByText(/Newer changes/)).toBeTruthy()
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    rerender(<BoardCardSummary card={{ ...card }} busy={false} />)
    expect(request).toHaveBeenCalledTimes(1)
    rerender(<BoardCardSummary card={{ ...card, summary_revision: "v3" }} busy={false} />)
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    rerender(<BoardCardSummary card={{ ...card, summary_current: true, summary: { ...card.summary!, text: "CI passed. Ready to ship." } }} busy={false} />)
    expect(screen.getByText("CI passed. Ready to ship.")).toBeTruthy()
    expect(screen.queryByText(/Newer changes/)).toBeNull()
  })

  it("keeps the old summary on delivery failure and retries on request", async () => {
    const request = vi.spyOn(boardApi, "requestSummary").mockRejectedValue(new Error("Agent unavailable"))
    render(<BoardCardSummary card={card} busy={false} />)
    expect(await screen.findByText("Agent unavailable")).toBeTruthy()
    expect(screen.getByText(card.summary!.text)).toBeTruthy()
    request.mockResolvedValue({ requested: true })
    fireEvent.click(screen.getByRole("button", { name: "Retry TL;DR" }))
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    expect(screen.queryByText("Agent unavailable")).toBeNull()
  })

  it.each([true, false])("bounds waiting even if the request answers: %s", async (answers) => {
    vi.useFakeTimers()
    vi.spyOn(boardApi, "requestSummary").mockImplementation(() => answers
      ? Promise.resolve({ requested: true })
      : new Promise(() => {}))
    render(<BoardCardSummary card={card} busy={false} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(screen.getByText(/hasn't updated/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Retry TL;DR" })).toBeTruthy()
  })

  it("explains how to get a missing summary when no agent is running", () => {
    const request = vi.spyOn(boardApi, "requestSummary")
    render(<BoardCardSummary card={{ ...card, summary: undefined, summary_agent: null }} busy={false} />)
    expect(screen.getByText(/Start this card's agent/)).toBeTruthy()
    expect(request).not.toHaveBeenCalled()
  })
})
