import { afterEach, beforeEach, expect, it, vi } from "vitest"

const ACCESS_OPEN = {
  password_set: false,
  required_here: false,
  signed_in: false,
  client_class: "network",
  access_verified: true,
}

let expired = false
const fetchMock = vi.fn(async (input: string) => {
  if (expired) {
    return new Response("Your Cloudflare Access sign-in expired.", {
      status: 401,
      headers: {
        "content-type": "text/plain",
        "Yaran-Refusal": "access-expired",
        "cache-control": "no-store",
      },
    })
  }
  const body = input.endsWith("/api/v1/auth/status") ? ACCESS_OPEN : {}
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
})

beforeEach(() => {
  vi.useFakeTimers()
  expired = false
  fetchMock.mockClear()
  vi.stubGlobal("fetch", fetchMock)
  vi.resetModules()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it("keeps native Access renewal reachable when the status probe gets a refusal", async () => {
  const gate = await import("./authGate")
  await gate.initAuthGate()
  expect(gate.getAuthPhase().kind).toBe("open")
  expired = true

  await gate.probeAfterDrop()

  expect(gate.getAuthPhase().kind).toBe("open")
  expect(gate.authPaused()).toBe(false)
})

it("returns an Access refusal to its caller without starting the password gate", async () => {
  const gate = await import("./authGate")
  const { apiFetch } = await import("./apiFetch")
  const { accessSession } = await import("./native/accessSession")
  await gate.initAuthGate()
  expired = true

  const response = await apiFetch("/api/v1/bootstrap")

  expect(response.status).toBe(401)
  await vi.waitFor(() => expect(accessSession.getSnapshot()).toEqual({
    state: "signin_needed", refusal: "access-expired",
  }))
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/api/v1/build"))).toBe(true)
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/api/v1/auth/status"))).toHaveLength(1)
  expect(gate.getAuthPhase().kind).toBe("open")
  expect(gate.authPaused()).toBe(false)
})
