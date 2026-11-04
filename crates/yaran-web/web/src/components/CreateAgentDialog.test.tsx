// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import type { CreateAgentTarget, YaranState } from "@/lib/store"

let mockState: YaranState
const submitNameDialog = vi.fn()
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>()
  return { ...actual, useYaran: () => mockState, submitNameDialog: (...args: unknown[]) => submitNameDialog(...args) }
})

function installBootStubs() {
  const values = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  })
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("offline test"))),
  )
}
installBootStubs()

const project = { id: "p1", name: "acme" }
const session = {
  id: "s1",
  title: "quacky-mallard",
  workspace: {
    kind: "managed",
    project_id: "p1",
    branch_name: "yaran/s1",
    initial_branch: "yaran/s1",
    branch_provenance: "created",
    source_branch: "",
    worktree_path: "",
  },
}

function seed(target: CreateAgentTarget, overrides: Partial<YaranState> = {}) {
  mockState = {
    createAgentTarget: target,
    createAgentDraft: "",
    createAgentRandomize: false,
    createAgentCopyChanges: false,
    createAgentNamePending: false,
    createAgentPrInput: "",
    createAgentPrResolving: false,
    createAgentPrError: null,
    spine: { projects: [project], sessions: [session] },
    ...overrides,
  } as unknown as YaranState
}

beforeEach(() => {
  submitNameDialog.mockClear()
  installBootStubs()
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("CreateAgentDialog", () => {
  it.each([{ isComposing: true }, { keyCode: 229 }])("does not create while confirming IME text: %o", async (composition) => {
    seed({ kind: "new", projectId: "p1" }, { createAgentDraft: "feature" })
    const { CreateAgentDialog } = await import("./CreateAgentDialog")
    render(<CreateAgentDialog />)
    const input = screen.getByRole("textbox", { name: "Agent name" })
    fireEvent.keyDown(input, { key: "Enter", ...composition })
    expect(submitNameDialog).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: "Enter" })
    expect(submitNameDialog).toHaveBeenCalledWith("feature")
  })

  it("renders new-agent controls for a project", async () => {
    seed({ kind: "new", projectId: "p1" })
    const { CreateAgentDialog } = await import("./CreateAgentDialog")
    render(<CreateAgentDialog />)

    expect(screen.getByRole("heading").textContent).toBe("New agent in acme")
    expect(screen.getByText("acme", { selector: "code" })).toBeTruthy()
    expect(screen.getByRole("textbox", { name: "Agent name" })).toBeTruthy()
    expect(screen.getByPlaceholderText("Agent name (optional)")).toBeTruthy()
    expect(screen.getByText(/configured shared checkout or isolated worktree/)).toBeTruthy()
    expect(screen.getByText(/In worktree mode, this also becomes the branch name/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Create agent" })).toBeTruthy()
    expect(
      screen.getByText("Copy uncommitted changes from the project checkout"),
    ).toBeTruthy()
  })

  it("requires a branch name when forking", async () => {
    seed({ kind: "fork", sessionId: "s1" })
    const { CreateAgentDialog } = await import("./CreateAgentDialog")
    render(<CreateAgentDialog />)

    expect(screen.getByRole("heading").textContent).toBe("Fork quacky-mallard")
    expect(
      screen.getByText("quacky-mallard", { selector: "code" }),
    ).toBeTruthy()
    expect(screen.getByPlaceholderText("Branch name")).toBeTruthy()
    expect(
      (screen.getByRole("button", { name: "Fork agent" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it("renders reference-first PR resolution and its inline error", async () => {
    seed(
      { kind: "pr", projectId: null },
      { createAgentPrError: "That repository is not open." },
    )
    const { CreateAgentDialog } = await import("./CreateAgentDialog")
    render(<CreateAgentDialog />)

    expect(screen.getByText("New agent from PR")).toBeTruthy()
    expect(screen.getByLabelText("GitHub pull request")).toBeTruthy()
    expect(screen.getByRole("alert").textContent).toBe(
      "That repository is not open.",
    )
    expect(screen.getByText("or choose an existing project")).toBeTruthy()
  })
})
