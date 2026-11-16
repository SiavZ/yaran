// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"

import type { YaranState } from "@/lib/store"

let mockState: YaranState
const closeConnectPhone = vi.fn()
const notifyInfo = vi.fn()
const phoneQr = vi.fn()

vi.mock("@/lib/store", () => ({
  useYaran: () => mockState,
  closeConnectPhone: () => closeConnectPhone(),
}))
vi.mock("@/lib/notify", () => ({ notifyInfo: (m: unknown) => notifyInfo(m) }))
vi.mock("@/lib/cloudApi", () => ({ cloudApi: { phoneQr: () => phoneQr() } }))

const { ConnectPhoneDialog } = await import("./ConnectPhoneDialog")

const ORG = "https://cp.example.com"
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'

function seed(open: boolean, paired: boolean) {
  mockState = {
    connectPhoneOpen: open,
    bootstrap: { cloud: { paired, org_url: ORG, hostname: "laptop-ada.example.com" } },
  } as unknown as YaranState
}

beforeEach(() => {
  closeConnectPhone.mockClear()
  notifyInfo.mockClear()
  phoneQr.mockReset()
})
afterEach(() => cleanup())

describe("ConnectPhoneDialog", () => {
  it("fetches the code and shows it as an image data URI beside the org chip", async () => {
    phoneQr.mockResolvedValue({ url: ORG, uri: "yaranapp://add-org?u=x", svg: SVG })
    seed(true, true)
    render(<ConnectPhoneDialog />)
    const img = (await screen.findByAltText("QR code for the yaran app")) as HTMLImageElement
    expect(img.getAttribute("src")).toBe(`data:image/svg+xml,${encodeURIComponent(SVG)}`)
    const chip = document.querySelector('[data-slot="inline-code"]')
    expect(chip?.textContent).toBe(ORG)
    expect(phoneQr).toHaveBeenCalledTimes(1)
  })

  it("says what failed when the code cannot be loaded", async () => {
    phoneQr.mockRejectedValue(new Error("This machine is not paired with an org."))
    seed(true, true)
    render(<ConnectPhoneDialog />)
    expect(await screen.findByText("This machine is not paired with an org.")).toBeTruthy()
  })

  it("closes itself and says so when the machine stops being paired", async () => {
    phoneQr.mockReturnValue(new Promise(() => {}))
    seed(true, true)
    const { rerender } = render(<ConnectPhoneDialog />)
    seed(true, false)
    await act(async () => rerender(<ConnectPhoneDialog />))
    expect(closeConnectPhone).toHaveBeenCalledTimes(1)
    expect(notifyInfo).toHaveBeenCalledTimes(1)
    const prose = notifyInfo.mock.calls[0][0] as unknown[]
    expect(prose).toContainEqual(expect.objectContaining({ name: ORG }))
    expect(prose).toContainEqual(expect.objectContaining({ name: "yaran cloud login" }))
  })
})
