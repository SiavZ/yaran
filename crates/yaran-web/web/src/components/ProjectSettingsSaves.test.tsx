// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { PatchProjectBody } from "@/lib/projectsApi"

let state: Record<string, unknown>
const save = vi.fn<(id: string, patch: PatchProjectBody) => Promise<boolean>>()
const close = vi.fn()
vi.mock("@/lib/store", () => ({
  useYaran: () => state,
  updateProjectSettings: (id: string, patch: PatchProjectBody) => save(id, patch),
  closeAgentEnv: () => close(),
  closeProjectSettings: () => close(),
  closeAgentStartupCommand: () => close(),
}))
import { AgentEnvDialog } from "./AgentEnvDialog"
import { ProjectSettingsDialog } from "./ProjectSettingsDialog"
import { AgentStartupCommandDialog } from "./AgentStartupCommandDialog"

const cases = [
  { Component: AgentEnvDialog, target: "agentEnvTarget", id: "s1", next: "s2", label: "Project environment variables", draft: "KEY=draft" },
  { Component: ProjectSettingsDialog, target: "projectSettingsTarget", id: "p1", next: "p2", label: "Environment", draft: "KEY=draft" },
  { Component: AgentStartupCommandDialog, target: "agentStartupCommandTarget", id: "s1", next: "s2", label: "Startup command", draft: "npm run build" },
]

beforeEach(() => {
  close.mockReset()
  save.mockReset().mockResolvedValue(true)
  state = {
    bootstrap: { available_providers: ["codex"] },
    spine: {
      projects: ["p1", "p2"].map(id => ({ id, name: id, env: {}, auto_reopen_agents: null })),
      sessions: [1, 2].map(i => ({ id: `s${i}`, title: `Agent ${i}`, workspace: { kind: "managed", project_id: `p${i}` } })),
    },
  }
})
afterEach(cleanup)

describe.each(cases)("$target save lifecycle", ({ Component, target, id, next, label, draft }) => {
  it("keeps the draft and prevents Cancel/Escape while a save is pending", async () => {
    let finish!: (ok: boolean) => void
    save.mockReturnValueOnce(new Promise<boolean>(resolve => { finish = resolve }))
    state[target] = id
    render(<Component />)
    fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value: draft } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    expect(close).not.toHaveBeenCalled()
    await act(async () => { finish(false) })
    expect((screen.getByRole("textbox", { name: label }) as HTMLTextAreaElement).value).toBe(draft)
    expect(close).not.toHaveBeenCalled()
  })

  it("cannot close a different target when the old save finishes", async () => {
    let finish!: (ok: boolean) => void
    save.mockReturnValueOnce(new Promise<boolean>(resolve => { finish = resolve }))
    state[target] = id
    const view = render(<Component />)
    fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value: draft } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    state[target] = next
    view.rerender(<Component />)
    await act(async () => { finish(true) })
    expect(close).not.toHaveBeenCalled()
    const input = screen.getByRole("textbox", { name: label }) as HTMLTextAreaElement
    expect(input.value).toBe("")
    fireEvent.change(input, { target: { value: "KEY=new" } })
    expect(input.value).toBe("KEY=new")
  })
})

describe.each(cases.slice(0, 2))("$target environment patches", ({ Component, target, id, label }) => {
  it.each<{ name: string; env: Record<string, string>; draft: string | null; patch: PatchProjectBody }>([
    {
      name: "leaves the untouched, alphabetically displayed environment unchanged",
      env: { Z_LAST: "last", A_FIRST: "first" },
      draft: null,
      patch: {},
    },
    {
      name: "ignores comments and key order when values are unchanged",
      env: { Z_LAST: "last", A_FIRST: "first" },
      draft: "# explanatory comment\nA_FIRST=first\n\nZ_LAST=last",
      patch: {},
    },
    {
      name: "sends changed values with the same number of keys",
      env: { Z_LAST: "last", A_FIRST: "first" },
      draft: "A_FIRST=changed\nZ_LAST=last",
      patch: { env: { A_FIRST: "changed", Z_LAST: "last" } },
    },
    {
      name: "sends an environment with removed keys",
      env: { Z_LAST: "last", A_FIRST: "first" },
      draft: "A_FIRST=first",
      patch: { env: { A_FIRST: "first" } },
    },
    {
      name: "sends an empty environment when all keys are removed",
      env: { KEY: "value" },
      draft: "# cleared",
      patch: { env: {} },
    },
    {
      name: "compares own prototype-named keys without depending on their order",
      env: { Z_LAST: "last", ["__proto__"]: "own", constructor: "plain" },
      draft: "constructor=plain\n__proto__=own\nZ_LAST=last",
      patch: {},
    },
    {
      name: "preserves changes to own prototype-named keys",
      env: { ["__proto__"]: "before" },
      draft: "__proto__=after",
      patch: { env: { ["__proto__"]: "after" } },
    },
  ])("$name", async ({ env, draft, patch }) => {
    const spine = state.spine as { projects: { id: string; env: Record<string, string> }[] }
    spine.projects[0].env = env
    state[target] = id
    render(<Component />)
    if (draft !== null) {
      fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value: draft } })
    }
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })) })
    expect(save).toHaveBeenCalledExactlyOnceWith("p1", patch)
    expect(close).toHaveBeenCalledOnce()
  })
})
