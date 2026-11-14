// @vitest-environment jsdom
//
// Tests for the Yaran Cloud dialog: its three states (connect, waiting on a
// browser, paired), the Connect flow (the approval page opens in a new tab from
// the click, the fingerprint and URL are chips, a pasted address completes), and
// both destructive confirms (Cancel autofocused, nothing sent until confirmed).
//
// <module-headers:begin>
// Uses:
// src/components/cloud/CloudDialog.test.tsx
// ├── src/components/cloud/CloudDialog.tsx
// └── src/lib/cloudApi.ts
// External: @testing-library/react, vitest
//
// Used by: entry point (vitest, via npx vitest run in crates/yaran-web/web)
// <module-headers:end>
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { CloudLogin, CloudStatus } from "@/lib/cloudApi"

const api = {
  status: vi.fn<() => Promise<CloudStatus>>(),
  startLogin: vi.fn<(org: string) => Promise<CloudLogin>>(),
  completeLogin: vi.fn<(id: string, url: string) => Promise<{ finished: boolean }>>(),
  cancelLogin: vi.fn<(id: string) => Promise<void>>(),
  logout: vi.fn(() => Promise.resolve({ ok: true, message: "" })),
  rotate: vi.fn(() => Promise.resolve({ ok: true, message: "" })),
}
vi.mock("@/lib/cloudApi", () => ({ cloudApi: api }))
const notifyError = vi.fn()
vi.mock("@/lib/notify", () => ({ notifyError: (m: string) => notifyError(m) }))
vi.mock("@/lib/store", () => ({
  useYaran: () => ({ cloudDialogOpen: true }),
  closeCloudDialog: vi.fn(),
}))

const { CloudDialog } = await import("./CloudDialog")

const LOGIN: CloudLogin = {
  login_id: "l1",
  authorize_url: "https://cloud.example.com/v1/pair/authorize?state=s",
  fingerprint: "K7QF-3MZD-W2PA-HX5R-LC4N-TB6E",
  org_name: "Example Org",
}

function status(over: Partial<CloudStatus> = {}): CloudStatus {
  return {
    paired: false,
    mode: "auto",
    default_org_url: "https://cloud.example.com",
    active_login: null,
    ...over,
  }
}

const PAIRED = status({
  paired: true,
  org_name: "Example Org",
  hostname: "laptop-sam.machines.example.com",
  owner_email: "sam@example.com",
})

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("CloudDialog", () => {
  it("offers Connect with the configured org address pre-filled", async () => {
    api.status.mockResolvedValue(status())
    render(<CloudDialog />)
    const field = await screen.findByLabelText("Organization address")
    expect((field as HTMLInputElement).value).toBe("https://cloud.example.com")
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy()
  })

  it("opens the approval page from the click and shows the fingerprint and URL as chips", async () => {
    api.status.mockResolvedValue(status())
    api.startLogin.mockResolvedValue(LOGIN)
    const tab = { opener: {}, location: { href: "" }, close: vi.fn() }
    const open = vi.fn(() => tab)
    vi.stubGlobal("open", open)
    render(<CloudDialog />)
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }))
    // Opened synchronously in the click, before the request resolves.
    expect(open).toHaveBeenCalledWith("about:blank", "_blank")
    expect(tab.opener).toBeNull()
    await screen.findByText(LOGIN.fingerprint, { selector: "code" })
    expect(api.startLogin).toHaveBeenCalledWith("https://cloud.example.com")
    expect(tab.location.href).toBe(LOGIN.authorize_url)
    expect(screen.getByText(LOGIN.authorize_url, { selector: "code" })).toBeTruthy()
    expect(screen.getByText(LOGIN.org_name, { selector: "code" })).toBeTruthy()
    expect(screen.getByText(/same code/)).toBeTruthy()
  })

  it("shows a refused start inline and closes the blank tab", async () => {
    api.status.mockResolvedValue(status())
    api.startLogin.mockRejectedValue(new Error("The control plane speaks protocol versions 9 to 9."))
    const tab = { opener: {}, location: { href: "" }, close: vi.fn() }
    vi.stubGlobal("open", vi.fn(() => tab))
    render(<CloudDialog />)
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }))
    expect((await screen.findByRole("alert")).textContent).toContain("protocol versions")
    expect(tab.close).toHaveBeenCalled()
  })

  it("completes a waiting login with the pasted landing address", async () => {
    api.status.mockResolvedValueOnce(status({ active_login: LOGIN }))
    api.status.mockResolvedValue(PAIRED)
    api.completeLogin.mockResolvedValue({ finished: true })
    render(<CloudDialog />)
    const field = await screen.findByLabelText("Landing address")
    fireEvent.change(field, { target: { value: "http://127.0.0.1:5/callback?code=c&state=s" } })
    fireEvent.click(screen.getByRole("button", { name: "Finish" }))
    await waitFor(() =>
      expect(api.completeLogin).toHaveBeenCalledWith("l1", "http://127.0.0.1:5/callback?code=c&state=s"),
    )
    await screen.findByRole("button", { name: "Disconnect…" })
  })

  it("shows a rejected paste inline and keeps waiting", async () => {
    api.status.mockResolvedValue(status({ active_login: LOGIN }))
    api.completeLogin.mockRejectedValue(new Error("That address is not this login's callback."))
    render(<CloudDialog />)
    fireEvent.change(await screen.findByLabelText("Landing address"), {
      target: { value: "http://127.0.0.1:1/callback" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Finish" }))
    expect((await screen.findByRole("alert")).textContent).toContain("not this login")
    expect(screen.getByLabelText("Landing address")).toBeTruthy()
  })

  it("cancels a waiting login", async () => {
    api.status.mockResolvedValueOnce(status({ active_login: LOGIN }))
    api.status.mockResolvedValue(status())
    api.cancelLogin.mockResolvedValue(undefined)
    render(<CloudDialog />)
    fireEvent.click(await screen.findByRole("button", { name: "Cancel login" }))
    await waitFor(() => expect(api.cancelLogin).toHaveBeenCalledWith("l1"))
    await screen.findByLabelText("Organization address")
  })

  it("polls the status while a login waits on a browser", async () => {
    vi.useFakeTimers()
    try {
      api.status.mockResolvedValue(status({ active_login: LOGIN }))
      render(<CloudDialog />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      const before = api.status.mock.calls.length
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_100)
      })
      expect(api.status.mock.calls.length).toBeGreaterThanOrEqual(before + 2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("shows the paired machine with its names as chips", async () => {
    api.status.mockResolvedValue(PAIRED)
    render(<CloudDialog />)
    await screen.findByText("laptop-sam.machines.example.com", { selector: "code" })
    expect(screen.getByText("Example Org", { selector: "code" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Rotate token…" })).toBeTruthy()
  })

  for (const [opener, confirmName, call] of [
    ["Disconnect…", "Disconnect", api.logout],
    ["Rotate token…", "Rotate token", api.rotate],
  ] as const) {
    it(`asks before ${confirmName}, with Cancel autofocused, and Cancel sends nothing`, async () => {
      api.status.mockResolvedValue(PAIRED)
      render(<CloudDialog />)
      fireEvent.click(await screen.findByRole("button", { name: opener }))
      const cancel = await screen.findByRole("button", { name: "Cancel" })
      await waitFor(() => expect(document.activeElement).toBe(cancel))
      expect(screen.getByRole("button", { name: confirmName }).className).toContain("destructive")
      fireEvent.click(cancel)
      expect(call).not.toHaveBeenCalled()
    })

    // The Cloud dialog queues its own first focus for the next animation frame.
    // A confirm that opens before that frame runs must still end on Cancel.
    it(`keeps Cancel focused when ${confirmName} opens before the dialog's first focus frame`, async () => {
      const frames = new Map<number, FrameRequestCallback>()
      let next = 0
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        frames.set(++next, cb)
        return next
      })
      vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
      api.status.mockResolvedValue(PAIRED)
      render(<CloudDialog />)
      fireEvent.click(await screen.findByRole("button", { name: opener }))
      const cancel = await screen.findByRole("button", { name: "Cancel" })
      act(() => {
        for (let i = 0; i < 20 && frames.size > 0; i++) {
          const batch = [...frames.values()]
          frames.clear()
          for (const cb of batch) cb(0)
        }
      })
      expect(document.activeElement).toBe(cancel)
    })

    it(`sends ${confirmName} only once confirmed`, async () => {
      api.status.mockResolvedValue(PAIRED)
      render(<CloudDialog />)
      fireEvent.click(await screen.findByRole("button", { name: opener }))
      expect(call).not.toHaveBeenCalled()
      fireEvent.click(await screen.findByRole("button", { name: confirmName }))
      await waitFor(() => expect(call).toHaveBeenCalledOnce())
    })
  }

  it("raises a toast of its own only when the request itself fails", async () => {
    api.status.mockResolvedValue(PAIRED)
    api.logout.mockRejectedValueOnce(new Error("Could not reach the server."))
    render(<CloudDialog />)
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect…" }))
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }))
    await waitFor(() => expect(notifyError).toHaveBeenCalledWith("Could not reach the server."))
  })
})
