// @vitest-environment jsdom
/**
 * The real store and the real phone-link cache across an events-socket outage: a re-pairing
 * whose `cloud.changed` was missed while disconnected must not leave "Copy phone link" copying
 * the old machine's link. The reconnect forgets the target the moment it starts, asks nothing
 * while the page is still checking which yaran answered (the identity gate), and asks again
 * only when that check lets the page recover; an answer still in flight is never mistaken for
 * the new one.
 *
 * <module-headers:begin>
 * <module-headers:end>
 */
import { act, cleanup, render } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const copyToClipboard = vi.fn(async (_: string) => true)
vi.mock("./clipboard", () => ({ copyToClipboard: (t: string) => copyToClipboard(t) }))
// The link-target route itself is phoneApi's own test; here it answers from `answers`.
vi.mock("./phoneApi", () => ({
  phoneApi: {
    linkTarget: () => {
      linkAsks += 1
      return answer()
    },
  },
}))

const MID_A = "0b5f9a8e-6d0e-4f43-9a51-1d6f7d9b1c2a"
const MID_B = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b"
const target = (cp: string, mid: string) => ({ publisher_domain: "apps.example.org", target: { kind: "org", orgUrl: cp, machineId: mid } })
const LINK_A = `https://apps.example.org/open#o=https%3A%2F%2Fcp.example.com&m=${MID_A}&a=s1`
const LINK_B = `https://apps.example.org/open#o=https%3A%2F%2Fcp2.example.com&m=${MID_B}&a=s1`

/** What the server answers now: A until the re-pairing, B (held back) after it. */
let answer: () => Promise<unknown> = () => Promise.resolve(target("https://cp.example.com", MID_A))
let linkAsks = 0
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } })

/** Set by a test that holds the reconnect's identity read; resolving it answers that read. */
let holdBuild: ((body: unknown) => void) | null = null
let holdingBuild = false
/** Whether the page knows its yaran (so a reconnect waits on the identity check). */
let knowsInstance = false
const RUN_1 = { version: "development", process: "run-1", instance: "yaran-a" }

const fetchMock = vi.fn(async (url: string) => {
  const u = String(url)
  if (u.includes("/api/v1/bootstrap")) return json({ available_providers: [], macros: [], welcome_tips: [], global_env: {} })
  if (knowsInstance && u.includes("/api/v1/auth/status")) {
    return json({ password_set: false, required_here: false, signed_in: false, instance: "yaran-a" })
  }
  if (knowsInstance && u.includes("/api/v1/build")) {
    if (holdingBuild) return new Promise((resolve) => (holdBuild = (body) => resolve(json(body))))
    return json(RUN_1)
  }
  return json({})
})

class FakeWebSocket {
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  readyState = 0
  send() {}
  close() {}
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

beforeEach(() => {
  answer = () => Promise.resolve(target("https://cp.example.com", MID_A))
  linkAsks = 0
  holdBuild = null
  holdingBuild = false
  knowsInstance = false
  copyToClipboard.mockClear()
  vi.stubGlobal("WebSocket", FakeWebSocket)
  vi.stubGlobal("fetch", fetchMock)
  vi.resetModules()
})

afterEach(async () => {
  cleanup()
  const store = await import("./store")
  store.eventsSocket.dispose()
  vi.unstubAllGlobals()
})

describe("phone link across a reconnect", () => {
  it("a re-pairing missed while disconnected is asked again, and the menu copies B, never A", async () => {
    const store = await import("./store")
    const phone = await import("./phoneLink")
    phone.resetPhoneLinkForTests()
    let seen: ReturnType<typeof phone.usePhoneLinkTarget> = { phase: "idle" }
    const Probe = () => {
      seen = phone.usePhoneLinkTarget()
      return null
    }
    render(createElement(Probe))
    await act(() => vi.waitFor(() => expect(seen.phase).toBe("ready")))
    phone.copyPhoneLink(seen, "s1")
    expect(copyToClipboard).toHaveBeenLastCalledWith(LINK_A)

    // The socket drops; the machine is re-paired to B and its cloud.changed is never seen.
    const pairedB = deferred<unknown>()
    answer = () => pairedB.promise
    const asked = linkAsks
    store.eventsSocket.onOpen() // the boot open
    store.eventsSocket.onOpen() // the reconnect, well inside the ten-minute cache
    await act(() => vi.waitFor(() => expect(linkAsks).toBeGreaterThan(asked)))
    expect(seen.phase).not.toBe("ready")

    // While the new answer is in flight the old one is gone: a press copies nothing.
    copyToClipboard.mockClear()
    phone.copyPhoneLink(seen, "s1")
    expect(copyToClipboard).not.toHaveBeenCalledWith(LINK_A)

    await act(async () => pairedB.resolve(target("https://cp2.example.com", MID_B)))
    await act(() => vi.waitFor(() => expect(seen.phase).toBe("ready")))
    phone.copyPhoneLink(seen, "s1")
    expect(copyToClipboard).toHaveBeenLastCalledWith(LINK_B)
    expect(copyToClipboard).not.toHaveBeenCalledWith(LINK_A)
  })

  it("while the reconnect's identity check is out, nothing copies A and nothing asks; after it, the press copies B", async () => {
    knowsInstance = true
    const store = await import("./store")
    const phone = await import("./phoneLink")
    phone.resetPhoneLinkForTests()
    await vi.waitFor(() => expect(store.getSnapshot().booted).toBe(true))
    store.eventsSocket.onOpen() // the boot open
    let seen: ReturnType<typeof phone.usePhoneLinkTarget> = { phase: "idle" }
    const Probe = () => {
      seen = phone.usePhoneLinkTarget()
      return null
    }
    render(createElement(Probe))
    await act(() => vi.waitFor(() => expect(seen.phase).toBe("ready")))
    const menuOfA = seen
    phone.copyPhoneLink(menuOfA, "s1")
    expect(copyToClipboard).toHaveBeenLastCalledWith(LINK_A)

    // Re-paired to B while offline (its cloud.changed missed); the reconnect's identity read is slow.
    const pairedB = deferred<unknown>()
    answer = () => pairedB.promise
    holdingBuild = true
    const asked = linkAsks
    act(() => store.eventsSocket.onOpen())
    await vi.waitFor(() => expect(holdBuild).toBeTypeOf("function"))

    // At once, before the identity answer: A is gone, from the open menu and from a stale press.
    expect(seen.phase).not.toBe("ready")
    copyToClipboard.mockClear()
    phone.copyPhoneLink(menuOfA, "s1")
    phone.copyPhoneLink(seen, "s1")
    // A menu opened now, and a cloud.changed replayed now, ask nothing yet.
    let reopened: ReturnType<typeof phone.usePhoneLinkTarget> = { phase: "idle" }
    const Reopened = () => {
      reopened = phone.usePhoneLinkTarget()
      return null
    }
    render(createElement(Reopened))
    act(() => phone.invalidatePhoneLinkTarget())
    await act(() => new Promise((r) => setTimeout(r, 20)))
    phone.copyPhoneLink(reopened, "s1")
    expect(copyToClipboard).not.toHaveBeenCalled()
    expect(linkAsks).toBe(asked)

    // Same yaran, same run: the recovery runs, asks again, and the next press copies B.
    await act(async () => holdBuild?.(RUN_1))
    await act(() => vi.waitFor(() => expect(linkAsks).toBeGreaterThan(asked)))
    await act(async () => pairedB.resolve(target("https://cp2.example.com", MID_B)))
    await act(() => vi.waitFor(() => expect(reopened.phase).toBe("ready")))
    phone.copyPhoneLink(reopened, "s1")
    expect(copyToClipboard).toHaveBeenLastCalledWith(LINK_B)
    expect(copyToClipboard).not.toHaveBeenCalledWith(LINK_A)
  })
})
