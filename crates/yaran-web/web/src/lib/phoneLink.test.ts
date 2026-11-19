// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const linkTarget = vi.fn()
const copyToClipboard = vi.fn()
const notifySuccess = vi.fn()
const notifyWarning = vi.fn()
const notifyInfo = vi.fn()
vi.mock("./phoneApi", () => ({ phoneApi: { linkTarget: () => linkTarget() } }))
vi.mock("./clipboard", () => ({ copyToClipboard: (t: string) => copyToClipboard(t) }))
vi.mock("./notify", () => ({
  notifySuccess: (m: unknown) => notifySuccess(m),
  notifyWarning: (m: unknown) => notifyWarning(m),
  notifyInfo: (m: unknown) => notifyInfo(m),
}))

const { copyPhoneLink, invalidatePhoneLinkTarget, loadPhoneLinkTarget, phoneLinkFor, resetPhoneLinkForTests, TARGET_TTL_MS, usePhoneLinkTarget } =
  await import("./phoneLink")
type State = Parameters<typeof phoneLinkFor>[0]

const MID = "0b5f9a8e-6d0e-4f43-9a51-1d6f7d9b1c2a"
const ORG_A = { publisher_domain: "apps.example.org", target: { kind: "org" as const, orgUrl: "https://cp.example.com", machineId: MID } }
const DIRECT = { publisher_domain: "apps.example.org", target: { kind: "direct" as const, host: "laptop.tail1234.ts.net" } }
const org: State = { phase: "ready", target: ORG_A, at: Date.now() }
const direct: State = { phase: "ready", target: DIRECT, at: Date.now() }
const LINK_A = `https://apps.example.org/open#o=https%3A%2F%2Fcp.example.com&m=${MID}&a=s1`
const MID_B = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b"
const ORG_B = { publisher_domain: "apps2.example.org", target: { kind: "org" as const, orgUrl: "https://cp2.example.com", machineId: MID_B } }
const LINK_B = `https://apps2.example.org/open#o=https%3A%2F%2Fcp2.example.com&m=${MID_B}&a=s1`

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

/** Renders a menu item's hook and returns a reader of the state it currently shows. */
function mountMenu() {
  let seen: State = { phase: "idle" }
  function Probe() {
    seen = usePhoneLinkTarget()
    return null
  }
  const view = render(createElement(Probe))
  return { now: () => seen, unmount: view.unmount }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

beforeEach(() => {
  resetPhoneLinkForTests()
  for (const f of [linkTarget, copyToClipboard, notifySuccess, notifyWarning, notifyInfo]) f.mockReset()
})

describe("phone links", () => {
  it("builds the exact verified link for an agent and for one of its tabs", () => {
    expect(phoneLinkFor(org, "s1")).toBe(
      `https://apps.example.org/open#o=https%3A%2F%2Fcp.example.com&m=${MID}&a=s1`,
    )
    expect(phoneLinkFor(direct, "s1", "t/2")).toBe("https://apps.example.org/open#d=laptop.tail1234.ts.net&a=s1&t=t%2F2")
    expect(phoneLinkFor(direct, "has space")).toBeNull()
    expect(phoneLinkFor({ phase: "loading" }, "s1")).toBeNull()
  })

  it("copies inside the press and confirms, since the clipboard is invisible", async () => {
    copyToClipboard.mockResolvedValue(true)
    linkTarget.mockResolvedValueOnce(DIRECT)
    const menu = mountMenu()
    await act(flush)
    copyPhoneLink(menu.now(), "s1")
    expect(copyToClipboard).toHaveBeenCalledWith("https://apps.example.org/open#d=laptop.tail1234.ts.net&a=s1")
    await Promise.resolve()
    await Promise.resolve()
    expect(notifySuccess).toHaveBeenCalledTimes(1)
  })

  it("copies nothing where no link can be made, says why, and asks again", async () => {
    linkTarget.mockReturnValue(new Promise(() => {}))
    copyPhoneLink({ phase: "refused", message: "No single https callback." }, "s1")
    expect(copyToClipboard).not.toHaveBeenCalled()
    expect(notifyWarning).toHaveBeenCalledWith("No single https callback.")
    expect(linkTarget).toHaveBeenCalledTimes(1)
    copyPhoneLink({ phase: "loading" }, "s1")
    expect(notifyInfo).toHaveBeenCalledTimes(1)
    expect(copyToClipboard).not.toHaveBeenCalled()
  })

  it("asks once while a target is known or on its way", async () => {
    linkTarget.mockReturnValue(new Promise(() => {}))
    loadPhoneLinkTarget()
    loadPhoneLinkTarget()
    expect(linkTarget).toHaveBeenCalledTimes(1)
  })

  it("a cloud or config change forgets the target: the open menu asks again and the next copy uses B", async () => {
    copyToClipboard.mockResolvedValue(true)
    linkTarget.mockResolvedValueOnce(ORG_A)
    const menu = mountMenu()
    await act(flush)
    copyPhoneLink(menu.now(), "s1")
    expect(copyToClipboard).toHaveBeenLastCalledWith(LINK_A)
    linkTarget.mockResolvedValueOnce(ORG_B)
    act(() => invalidatePhoneLinkTarget())
    expect(linkTarget).toHaveBeenCalledTimes(2)
    await act(flush)
    copyPhoneLink(menu.now(), "s1")
    expect(copyToClipboard).toHaveBeenLastCalledWith(LINK_B)
    menu.unmount()
  })

  it("a menu opened again after a change fetches rather than reusing A", async () => {
    copyToClipboard.mockResolvedValue(true)
    linkTarget.mockResolvedValueOnce(ORG_A)
    const first = mountMenu()
    await act(flush)
    first.unmount()
    invalidatePhoneLinkTarget()
    expect(linkTarget).toHaveBeenCalledTimes(1)
    linkTarget.mockResolvedValueOnce(ORG_B)
    const again = mountMenu()
    await act(flush)
    expect(linkTarget).toHaveBeenCalledTimes(2)
    copyPhoneLink(again.now(), "s1")
    expect(copyToClipboard).toHaveBeenCalledWith(LINK_B)
    expect(copyToClipboard).not.toHaveBeenCalledWith(LINK_A)
  })

  it("an answer asked before the change, landing after it, is dropped", async () => {
    copyToClipboard.mockResolvedValue(true)
    const old = deferred<typeof ORG_A>()
    linkTarget.mockReturnValueOnce(old.promise)
    const menu = mountMenu()
    linkTarget.mockResolvedValueOnce(ORG_B)
    act(() => invalidatePhoneLinkTarget())
    await act(flush)
    await act(async () => old.resolve(ORG_A))
    await act(flush)
    copyPhoneLink(menu.now(), "s1")
    expect(copyToClipboard).toHaveBeenCalledWith(LINK_B)
    expect(copyToClipboard).not.toHaveBeenCalledWith(LINK_A)
  })

  it("an expired target copies nothing, asks again, and the next press copies the new answer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    copyToClipboard.mockResolvedValue(true)
    linkTarget.mockResolvedValueOnce(ORG_A)
    const menu = mountMenu()
    await act(flush)
    vi.setSystemTime(Date.now() + TARGET_TTL_MS + 1)
    linkTarget.mockResolvedValueOnce(ORG_B)
    copyPhoneLink(menu.now(), "s1")
    expect(copyToClipboard).not.toHaveBeenCalled()
    expect(notifyInfo).toHaveBeenCalledTimes(1)
    expect(linkTarget).toHaveBeenCalledTimes(2)
    await act(flush)
    copyPhoneLink(menu.now(), "s1")
    expect(copyToClipboard).toHaveBeenCalledWith(LINK_B)
  })
})
