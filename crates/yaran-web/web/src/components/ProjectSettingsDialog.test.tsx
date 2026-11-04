// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("@/lib/store", () => ({
  useYaran: () => ({
    projectSettingsTarget: "p1",
    spine: { projects: [{ id: "p1", name: "demo", env: {}, auto_reopen_agents: null }] },
    bootstrap: { available_providers: ["codex"] },
  }),
  closeProjectSettings: vi.fn(),
  updateProjectSettings: vi.fn(),
}))
import { ProjectSettingsDialog } from "./ProjectSettingsDialog"

afterEach(cleanup)

describe("ProjectSettingsDialog", () => {
  it("gives each setting an associated label", () => {
    render(<ProjectSettingsDialog />)
    expect(screen.getByLabelText("Default provider").getAttribute("role")).toBe("combobox")
    expect(screen.getByLabelText("Auto-reopen agents").getAttribute("role")).toBe("combobox")
    expect(screen.getByRole("textbox", { name: "Startup command" })).toBeTruthy()
    expect(screen.getByRole("textbox", { name: "Environment" })).toBeTruthy()
  })

  it("shows inherited values before their option lists have opened", () => {
    render(<ProjectSettingsDialog />)
    expect(screen.getByLabelText("Default provider").textContent).toContain("Inherit global default")
    expect(screen.getByLabelText("Auto-reopen agents").textContent).toContain("Inherit global default")
  })

  it("blocks saving malformed environment lines instead of silently removing them", () => {
    render(<ProjectSettingsDialog />)
    fireEvent.change(screen.getByRole("textbox", { name: "Environment" }), { target: { value: "API_KEY" } })
    expect(screen.getByRole("alert").textContent).toBe("Line 1 must use KEY=VALUE.")
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true)
  })
})
