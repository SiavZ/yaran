// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"

import type { YaranState } from "@/lib/store"

let mockState: YaranState
const closeConnectPhone = vi.fn()
const phoneQr = vi.fn()
const machineQr = vi.fn()

vi.mock("@/lib/store", () => ({
  useYaran: () => mockState,
  closeConnectPhone: () => closeConnectPhone(),
}))
vi.mock("@/lib/cloudApi", () => ({ cloudApi: { phoneQr: () => phoneQr() } }))
vi.mock("@/lib/phoneApi", () => ({ phoneApi: { machineQr: () => machineQr() } }))

const { ConnectPhoneDialog } = await import("./ConnectPhoneDialog")

const ORG = "https://cp.example.com"
const HOST = "laptop.tail1234.ts.net"
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'
const NOT_HTTPS =
  "This page did not reach yaran over an HTTPS address yaran can vouch for, and the phone app only opens machines over HTTPS."

function seed(open: boolean, paired: boolean) {
  mockState = {
    connectPhoneOpen: open,
    bootstrap: { cloud: { paired, org_url: ORG, hostname: "laptop-ada.example.com" } },
  } as unknown as YaranState
}

const chips = () => Array.from(document.querySelectorAll('[data-slot="inline-code"]')).map((c) => c.textContent)

beforeEach(() => {
  closeConnectPhone.mockClear()
  phoneQr.mockReset()
  machineQr.mockReset()
  machineQr.mockReturnValue(new Promise(() => {}))
})
afterEach(() => cleanup())

describe("ConnectPhoneDialog", () => {
  it("shows the org code as an image data URI beside the org chip while paired", async () => {
    phoneQr.mockResolvedValue({ url: ORG, uri: "yaranapp://add-org?u=x", svg: SVG })
    seed(true, true)
    render(<ConnectPhoneDialog />)
    const img = (await screen.findByAltText("QR code for the yaran app")) as HTMLImageElement
    expect(img.getAttribute("src")).toBe(`data:image/svg+xml,${encodeURIComponent(SVG)}`)
    expect(chips()).toContain(ORG)
    expect(phoneQr).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Or directly, by this machine's address")).toBeTruthy()
  })

  it("says what failed when the org code cannot be loaded", async () => {
    phoneQr.mockRejectedValue(new Error("This machine is not paired with an org."))
    seed(true, true)
    render(<ConnectPhoneDialog />)
    expect(await screen.findByText("This machine is not paired with an org.")).toBeTruthy()
  })

  it("offers this machine directly without any organisation", async () => {
    machineQr.mockResolvedValue({ host: HOST, uri: "yaranapp://add-machine?u=x", svg: SVG })
    seed(true, false)
    render(<ConnectPhoneDialog />)
    const img = await screen.findByAltText("QR code that adds this machine to the yaran app")
    expect(img.getAttribute("src")).toBe(`data:image/svg+xml,${encodeURIComponent(SVG)}`)
    expect(chips()).toEqual([HOST])
    expect(phoneQr).not.toHaveBeenCalled()
    expect(screen.queryByText("Through your organisation")).toBeNull()
  })

  it("shows the server's sentence when the direct code needs HTTPS", async () => {
    machineQr.mockRejectedValue(new Error(NOT_HTTPS))
    seed(true, false)
    render(<ConnectPhoneDialog />)
    expect(await screen.findByText(NOT_HTTPS)).toBeTruthy()
    expect(screen.queryByRole("img")).toBeNull()
  })

  it("drops the org section, and only it, when the machine stops being paired", async () => {
    phoneQr.mockReturnValue(new Promise(() => {}))
    seed(true, true)
    const { rerender } = render(<ConnectPhoneDialog />)
    expect(screen.getByText("Through your organisation")).toBeTruthy()
    seed(true, false)
    await act(async () => rerender(<ConnectPhoneDialog />))
    expect(screen.queryByText("Through your organisation")).toBeNull()
    expect(screen.getByText("By this machine's address")).toBeTruthy()
    expect(closeConnectPhone).not.toHaveBeenCalled()
  })
})
