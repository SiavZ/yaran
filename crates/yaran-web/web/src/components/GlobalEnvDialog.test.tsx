// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

const save = vi.fn<(env: Record<string, string>) => Promise<boolean>>()
const close = vi.fn()
let globalEnvOpen = true
vi.mock("@/lib/store", () => ({
  useYaran: () => ({ globalEnvOpen, bootstrap: { global_env: { API_KEY: "old" } } }),
  saveGlobalEnv: (env: Record<string, string>) => save(env),
  closeGlobalEnv: () => close(),
}))
import { GlobalEnvDialog } from "./GlobalEnvDialog"

beforeEach(() => {
  save.mockReset()
  close.mockClear()
  globalEnvOpen = true
})
afterEach(cleanup)

describe("GlobalEnvDialog", () => {
  it("blocks Cancel and Escape during a save so its late result cannot dismiss a reopened draft", async () => {
    let finish!: (saved: boolean) => void
    save.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const { rerender } = render(<GlobalEnvDialog />)
    const input = screen.getByRole("textbox", { name: "Global environment variables" })
    fireEvent.change(input, { target: { value: "API_KEY=new" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    fireEvent.keyDown(input, { key: "Escape" })
    expect(close).not.toHaveBeenCalled()
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => finish(true))
    expect(close).toHaveBeenCalledTimes(1)
    globalEnvOpen = false
    rerender(<GlobalEnvDialog />)
    globalEnvOpen = true
    rerender(<GlobalEnvDialog />)
    fireEvent.change(screen.getByRole("textbox", { name: "Global environment variables" }), { target: { value: "API_KEY=later" } })
    await act(async () => Promise.resolve())
    expect(close).toHaveBeenCalledTimes(1)
    expect((screen.getByRole("textbox", { name: "Global environment variables" }) as HTMLTextAreaElement).value).toBe("API_KEY=later")
  })

  it("keeps the draft on a failed save and prevents duplicate requests while waiting", async () => {
    let finish!: (saved: boolean) => void
    save.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    render(<GlobalEnvDialog />)
    const input = screen.getByRole("textbox", { name: "Global environment variables" })
    fireEvent.change(input, { target: { value: "API_KEY=new" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(save).toHaveBeenCalledWith({ API_KEY: "new" })
    expect(close).not.toHaveBeenCalled()
    expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => finish(false))
    expect(close).not.toHaveBeenCalled()
    expect((input as HTMLTextAreaElement).value).toBe("API_KEY=new")
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false)
    save.mockResolvedValue(true)
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })))
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("refuses malformed environment lines before replacing the saved map", () => {
    render(<GlobalEnvDialog />)
    const input = screen.getByRole("textbox", { name: "Global environment variables" })
    fireEvent.change(input, { target: { value: "API_KEY" } })
    expect(screen.getByRole("alert").textContent).toBe("Line 1 must use KEY=VALUE.")
    expect(input.getAttribute("aria-invalid")).toBe("true")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(save).not.toHaveBeenCalled()
  })
})
