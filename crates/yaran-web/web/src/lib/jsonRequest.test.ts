import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./native/accessSession", () => ({
  accessSession: { noteRequestTrouble: vi.fn() },
}))

import { createJsonRequest } from "./jsonRequest"
import { accessSession } from "./native/accessSession"

class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

const request = createJsonRequest((m, s) => new RequestError(m, s))
const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  vi.mocked(accessSession.noteRequestTrouble).mockClear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe("createJsonRequest", () => {
  it("sends X-Requested-With so Access answers 401 rather than redirecting", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }))
    await request("GET", "/api/v1/x")
    expect(fetchMock.mock.calls[0][1].headers["X-Requested-With"]).toBe("XMLHttpRequest")
  })

  it("still gives undefined for 204 and an empty body, without a probe", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(request("POST", "/a")).resolves.toBeUndefined()
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }))
    await expect(request("POST", "/a")).resolves.toBeUndefined()
    expect(accessSession.noteRequestTrouble).not.toHaveBeenCalled()
  })

  it("fails a non-JSON 200 and asks for a probe", async () => {
    fetchMock.mockResolvedValue(new Response("<html>Sign in</html>", { status: 200 }))
    await expect(request("GET", "/a")).rejects.toThrow(/HTTP 200, not JSON/)
    expect(accessSession.noteRequestTrouble).toHaveBeenCalledTimes(1)
  })

  it("never puts an HTML error body in the message", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html><body>login</body></html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
    )
    const err = (await request("GET", "/a").catch((e) => e)) as RequestError
    expect(err.status).toBe(403)
    expect(err.message).not.toContain("<")
    expect(accessSession.noteRequestTrouble).toHaveBeenCalledTimes(1)
  })

  it("probes on a thrown fetch and on 401, but not on an ordinary 409", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    await expect(request("GET", "/a")).rejects.toThrow("Could not reach the server.")
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }))
    await expect(request("GET", "/a")).rejects.toThrow("request failed (401)")
    expect(accessSession.noteRequestTrouble).toHaveBeenCalledTimes(2)
    fetchMock.mockResolvedValueOnce(new Response("branch exists", { status: 409 }))
    await expect(request("GET", "/a")).rejects.toThrow("branch exists")
    expect(accessSession.noteRequestTrouble).toHaveBeenCalledTimes(2)
  })
})
