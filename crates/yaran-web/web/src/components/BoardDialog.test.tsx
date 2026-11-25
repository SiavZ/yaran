// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { BoardCard, BoardView } from "@/lib/boardApi"
import { proseText, type Prose } from "@/lib/prose"
import type { YaranState } from "@/lib/store"

const closeBoard = vi.fn()
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>()
  return {
    ...actual,
    useYaran: () => ({ boardOpen: true }) as unknown as YaranState,
    closeBoard: () => closeBoard(),
  }
})

const api = {
  get: vi.fn(),
  resolve: vi.fn(),
  reopen: vi.fn(),
  reply: vi.fn(),
  assign: vi.fn(),
  priority: vi.fn(),
  requestSummary: vi.fn(),
}
vi.mock("@/lib/boardApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/boardApi")>()
  return { ...actual, boardApi: api }
})

const notifySuccess = vi.fn()
const notifyError = vi.fn()
vi.mock("@/lib/notify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notify")>()
  return {
    ...actual,
    notifySuccess: (m: unknown) => notifySuccess(m),
    notifyError: (m: unknown) => notifyError(m),
  }
})

vi.stubGlobal(
  "matchMedia",
  vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })),
)
const { BoardDialog } = await import("./BoardDialog")

function card(over: Partial<BoardCard> & { id: number }): BoardCard {
  return {
    kind: "task",
    title: `card ${over.id}`,
    created_at: "2026-11-19T00:00:00Z",
    updated_at: "2026-11-19T00:00:00Z",
    label: `#${over.id}`,
    waiting: false,
    reply_agent: null,
    ...over,
  }
}

function board(cards: BoardCard[]): BoardView {
  return { people: ["Sam", "Alex"], me: "Sam", cards, problems: [] }
}

/** The plain spelling of the last success toast. */
function lastToast(): string {
  const notice = notifySuccess.mock.calls.at(-1)?.[0] as string | Prose
  return typeof notice === "string" ? notice : proseText(notice)
}

beforeEach(() => {
  vi.clearAllMocks()
  api.resolve.mockResolvedValue({ changed: true })
  api.reply.mockResolvedValue({ sent_to: "Fixer" })
  api.assign.mockResolvedValue({ changed: true })
  api.priority.mockResolvedValue({ changed: true })
})

afterEach(() => cleanup())

describe("BoardDialog", () => {
  it("puts the whole-card TL;DR before the detail and conversation", async () => {
    api.get.mockResolvedValue(board([card({
      id: 10, title: "Ship the fix?", detail: "Original request",
      summary_current: true,
      summary: { text: "Approved; waiting for CI.", revision: "v1", at: "2026-11-25T00:00:00Z" },
      thread: [{ at: "2026-11-25T00:00:00Z", from: "Sam", text: "Please check CI first" }],
    })]))
    render(<BoardDialog />)
    fireEvent.click(await screen.findByText("Ship the fix?"))
    expect(screen.getByRole("region", { name: "TL;DR" }).textContent).toContain("Approved; waiting for CI.")
    const text = screen.getByRole("dialog").textContent!
    expect(text.indexOf("Approved; waiting for CI.")).toBeLessThan(text.indexOf("Original request"))
    expect(text.indexOf("Original request")).toBeLessThan(text.indexOf("Please check CI first"))
    expect(api.requestSummary).not.toHaveBeenCalled()
  })

  it("opens on my queue, grouped by kind, and All shows the other queues too", async () => {
    api.get.mockResolvedValue(
      board([
        card({ id: 1, title: "Approve the terms" }),
        card({ id: 2, kind: "validate", title: "Check the phone page", assignee: "Alex" }),
        card({ id: 3, kind: "info", title: "Merged the fix" }),
      ]),
    )
    render(<BoardDialog />)

    expect(await screen.findByText("Approve the terms")).toBeTruthy()
    expect(screen.getByText("Tasks for you (1)")).toBeTruthy()
    expect(screen.getByText("What happened (1)")).toBeTruthy()
    expect(screen.queryByText("Check the phone page")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /^All/ }))
    expect(screen.getByText("Check the phone page")).toBeTruthy()
    expect(screen.getByText("Validation (1)")).toBeTruthy()
  })

  it("marks a card done from its view when the reply box is empty", async () => {
    api.get.mockResolvedValue(board([card({ id: 4, title: "Merge it?" })]))
    render(<BoardDialog />)
    fireEvent.click(await screen.findByText("Merge it?"))

    fireEvent.click(screen.getByRole("button", { name: /Mark done/ }))
    await waitFor(() => expect(api.resolve).toHaveBeenCalledWith(4))
    expect(api.reply).not.toHaveBeenCalled()
    expect(lastToast()).toContain("done")
  })

  it("sends a reply to the agent that posted the card and says so", async () => {
    api.get.mockResolvedValue(
      board([card({ id: 5, title: "Roll it?", reply_agent: "Fixer" })]),
    )
    render(<BoardDialog />)
    fireEvent.click(await screen.findByText("Roll it?"))
    expect(screen.getByText(/Your reply goes to/)).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText("Reply…"), {
      target: { value: "yes, roll it" },
    })
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }))
    await waitFor(() => expect(api.reply).toHaveBeenCalledWith(5, "yes, roll it", false))
    expect(lastToast()).toContain("sent to")
    expect(lastToast()).toContain("Fixer")
  })

  it("hands an open task to another queue and changes its priority", async () => {
    api.get.mockResolvedValue(board([card({ id: 6, title: "Pay the invoice" })]))
    render(<BoardDialog />)
    fireEvent.click(await screen.findByText("Pay the invoice"))

    fireEvent.click(screen.getByRole("button", { name: /Assign/ }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Alex" }))
    await waitFor(() => expect(api.assign).toHaveBeenCalledWith(6, "Alex"))

    fireEvent.click(screen.getByRole("button", { name: /Priority/ }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "high" }))
    await waitFor(() => expect(api.priority).toHaveBeenCalledWith(6, "high"))
  })

  it("offers no Assign for a card that is not a task", async () => {
    api.get.mockResolvedValue(
      board([card({ id: 7, kind: "confirm", title: "Drop the table?" })]),
    )
    render(<BoardDialog />)
    fireEvent.click(await screen.findByText("Drop the table?"))
    expect(screen.getByRole("button", { name: /Priority/ })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Assign/ })).toBeNull()
  })
})
