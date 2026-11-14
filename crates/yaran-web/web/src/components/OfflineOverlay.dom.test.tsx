// @vitest-environment jsdom
// Phase 13: the overlay's sign-in and server-problem faces.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import type { AccessSnapshot } from "@/lib/native/accessSession"
import type { YaranState } from "@/lib/store"

let mockState: YaranState
let snapshot: AccessSnapshot = { state: "ok" }
let native = false
const reconnectMock = vi.fn()
const recheckMock = vi.fn()

vi.mock("@/lib/store", () => ({
  useYaran: () => mockState,
  reconnect: reconnectMock,
}))
vi.mock("@/lib/native/accessSession", () => ({
  useAccessSession: () => snapshot,
  accessSession: { recheck: recheckMock },
}))
vi.mock("@/lib/native/nativeShell", () => ({ isNativeShell: () => native }))

const { OfflineOverlay } = await import("./OfflineOverlay")

const HOST = "laptop-ada.example.com"
const assign = vi.fn()

function seed(cloudHostname: string | null, s: AccessSnapshot, inApp = false) {
  mockState = {
    offline: false,
    conn: "open",
    reconnectPlan: null,
    bootstrap: { cloud: { paired: true, hostname: cloudHostname } },
  } as unknown as YaranState
  snapshot = s
  native = inApp
}

beforeEach(() => {
  // A page served on a port: the reauth host must still be the bare hostname.
  vi.stubGlobal("location", {
    hostname: HOST,
    host: `${HOST}:8443`,
    origin: `https://${HOST}:8443`,
    assign,
  })
  assign.mockClear()
  reconnectMock.mockClear()
  recheckMock.mockClear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const dialog = () => screen.getByRole("alertdialog")

describe("OfflineOverlay access faces", () => {
  it("shows nothing while the session is ok and the socket is up", () => {
    seed(HOST, { state: "ok" })
    const { container } = render(<OfflineOverlay />)
    expect(container.firstChild).toBeNull()
  })

  it("browser: Sign in opens the signed-in route in a new tab with noopener", () => {
    seed(HOST, { state: "signin_needed", refusal: "access-expired" })
    render(<OfflineOverlay />)
    expect(screen.getByText("Sign in again")).toBeTruthy()
    const link = screen.getByRole("link", { name: /sign in/i })
    expect(link.getAttribute("href")).toBe(`https://${HOST}:8443/__yaran/signed-in`)
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toBe("noopener")
    expect(screen.queryByRole("button", { name: /reconnect/i })).toBeNull()
  })

  it("renders the host as the inline-code chip, never quoted", () => {
    seed(HOST, { state: "signin_needed", refusal: null })
    render(<OfflineOverlay />)
    const chip = dialog().querySelector('[data-slot="inline-code"]')
    expect(chip?.textContent).toBe(HOST)
    expect(dialog().textContent).not.toContain(`"${HOST}"`)
  })

  it("names Cloudflare Access only on the cloud hostname", () => {
    seed(HOST, { state: "signin_needed", refusal: null })
    render(<OfflineOverlay />)
    expect(dialog().textContent).toContain("Cloudflare Access sign-in")
    cleanup()
    seed("other.example.com", { state: "signin_needed", refusal: null })
    render(<OfflineOverlay />)
    expect(dialog().textContent).not.toContain("Cloudflare")
    expect(dialog().textContent).toContain("Your sign-in for")
  })

  it("inside the app: Sign in navigates to the reauth control URL with the bare hostname", () => {
    seed(HOST, { state: "signin_needed", refusal: null }, true)
    render(<OfflineOverlay />)
    expect(screen.queryByRole("link")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }))
    expect(assign).toHaveBeenCalledWith(`yaranapp://reauth?host=${HOST}`)
    expect(dialog().textContent).toContain("picks up where it left off")
  })

  it.each([
    ["access-keys-unavailable", "key service"],
    ["host-not-served", "no longer connected to the cloud"],
    ["host-missing", "no longer connected to the cloud"],
  ] as const)("server_problem %s says %s and offers Reconnect only", (refusal, words) => {
    seed(HOST, { state: "server_problem", refusal })
    render(<OfflineOverlay />)
    expect(dialog().textContent).toContain(words)
    expect(screen.queryByRole("link")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /reconnect/i }))
    expect(reconnectMock).toHaveBeenCalledTimes(1)
    expect(recheckMock).toHaveBeenCalledTimes(1)
  })

  it("G3 fallback face offers both Sign in and Reconnect", () => {
    seed(HOST, { state: "signin_maybe" })
    render(<OfflineOverlay />)
    expect(screen.getByRole("link", { name: /sign in/i })).toBeTruthy()
    expect(screen.getByRole("button", { name: /reconnect/i })).toBeTruthy()
  })
})
