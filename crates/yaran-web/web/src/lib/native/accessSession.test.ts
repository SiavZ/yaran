/**
 * Tests for accessSession.ts: the probe table, the refusal registry, coalescing, the
 * visible-time re-probe and the G3 fallback.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/native/accessSession.test.ts
 * ├── src/lib/native/accessSession.ts
 * └── src/lib/ptySocket.ts
 * External: node:fs, node:path, node:url, vitest
 *
 * Used by: entry point (vitest, via npm test in crates/yaran-web/web)
 * <module-headers:end>
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PROVIDER_UNAVAILABLE_CLOSE } from "../ptySocket"
import {
  ACCESS_SESSION_EXPIRED_CLOSE,
  classifyProbe,
  createAccessSession,
  MIN_PROBE_GAP_MS,
  REFUSAL_CODES,
  REPROBE_VISIBLE_MS,
  type AccessSessionDeps,
  type ProbeResult,
} from "./accessSession"

const registry = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../../../cloud/protocol/registry/refusals.json",
    ),
    "utf8",
  ),
) as { header: string; refusals: { code: string; status: number }[] }

const IDENTITY = JSON.stringify({ version: "development", process: "p1" })

function resp(over: Partial<Extract<ProbeResult, { kind: "response" }>>): ProbeResult {
  return {
    kind: "response",
    type: "basic",
    status: 200,
    refusal: null,
    contentType: "application/json",
    body: IDENTITY,
    ...over,
  }
}

describe("classifyProbe", () => {
  it("reads every row of the table", () => {
    expect(classifyProbe(resp({ type: "opaqueredirect", status: 0, body: "" }))).toEqual({
      kind: "signin_needed",
      refusal: null,
    })
    expect(classifyProbe(resp({ status: 401, body: "" }))).toEqual({
      kind: "signin_needed",
      refusal: null,
    })
    expect(classifyProbe(resp({ status: 403, body: "" })).kind).toBe("signin_needed")
    expect(classifyProbe(resp({}))).toEqual({ kind: "ok" })
    expect(classifyProbe(resp({ contentType: "text/html", body: "<html>login</html>" }))).toEqual({
      kind: "signin_needed",
      refusal: null,
    })
    expect(classifyProbe(resp({ status: 502, body: "Bad gateway" }))).toEqual({
      kind: "unreachable",
    })
    expect(classifyProbe(resp({ status: 500 })).kind).toBe("unreachable")
    expect(classifyProbe({ kind: "threw" })).toEqual({ kind: "unreachable" })
  })

  it("holds the same codes as Phase 02's registry, in order", () => {
    expect(registry.header).toBe("Yaran-Refusal")
    expect([...REFUSAL_CODES]).toEqual(registry.refusals.map((r) => r.code))
  })

  it.each(registry.refusals)("maps $code and carries it verbatim", ({ code, status }) => {
    const out = classifyProbe(resp({ status, refusal: code, body: "" }))
    if (code === "access-keys-unavailable" || code.startsWith("host-")) {
      expect(out).toEqual({ kind: "server_problem", refusal: code })
    } else {
      expect(code.startsWith("access-")).toBe(true)
      expect(out).toEqual({ kind: "signin_needed", refusal: code })
    }
  })

  it("falls back to the status for a code the registry does not hold", () => {
    expect(classifyProbe(resp({ status: 503, refusal: "access-new-thing", body: "" }))).toEqual({
      kind: "unreachable",
    })
    expect(classifyProbe(resp({ status: 401, refusal: "host-new-thing", body: "" }))).toEqual({
      kind: "signin_needed",
      refusal: null,
    })
  })
})

function harness(over: Partial<AccessSessionDeps> = {}) {
  let elapsed = 0
  const responses: Array<() => Promise<Response>> = []
  const fetchMock = vi.fn(() => {
    const next = responses.shift()
    return next ? next() : Promise.reject(new TypeError("offline"))
  })
  const resume = vi.fn()
  const deps: AccessSessionDeps = {
    fetch: fetchMock as unknown as typeof fetch,
    now: () => Date.now(),
    clock: { elapsedMs: () => elapsed, reset: () => (elapsed = 0), dispose: () => {} },
    resume,
    cloudHostname: () => "laptop-ada.example.com",
    pageHostname: () => "laptop-ada.example.com",
    online: () => true,
    g3Fallback: false,
    ...over,
  }
  const session = createAccessSession(deps)
  return {
    session,
    fetchMock,
    resume,
    queue: (r: () => Promise<Response>) => responses.push(r),
    advanceVisible: (ms: number) => (elapsed += ms),
  }
}

const unauthorized = () => Promise.resolve(new Response("", { status: 401 }))
const identity = () =>
  Promise.resolve(
    new Response(IDENTITY, { status: 200, headers: { "content-type": "application/json" } }),
  )

describe("createAccessSession", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("sends the probe Access answers with 401 instead of a redirect", async () => {
    const h = harness()
    h.queue(identity)
    h.session.noteRequestTrouble()
    await vi.runOnlyPendingTimersAsync()
    const init = (h.fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.redirect).toBe("manual")
    expect(init.cache).toBe("no-store")
    expect(init.headers).toEqual({ "X-Requested-With": "XMLHttpRequest" })
  })

  it("coalesces ten triggers into one fetch", async () => {
    const h = harness()
    h.queue(unauthorized)
    for (let i = 0; i < 10; i++) h.session.noteConnectionTrouble()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.fetchMock).toHaveBeenCalledTimes(1)
    expect(h.session.getSnapshot()).toEqual({ state: "signin_needed", refusal: null })
    // Triggers inside the minimum gap schedule exactly one more probe.
    for (let i = 0; i < 10; i++) h.session.noteSessionExpired()
    await vi.advanceTimersByTimeAsync(MIN_PROBE_GAP_MS)
    expect(h.fetchMock).toHaveBeenCalledTimes(2)
  })

  it("re-probes on visible time only, and resumes exactly once on ok", async () => {
    const h = harness()
    h.queue(unauthorized)
    h.session.noteRequestTrouble()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.session.getSnapshot().state).toBe("signin_needed")

    // Hidden: wall time passes, visible time does not, so nothing is fetched.
    await vi.advanceTimersByTimeAsync(REPROBE_VISIBLE_MS * 3)
    expect(h.fetchMock).toHaveBeenCalledTimes(1)

    h.queue(identity)
    h.advanceVisible(REPROBE_VISIBLE_MS)
    await vi.advanceTimersByTimeAsync(REPROBE_VISIBLE_MS)
    expect(h.fetchMock).toHaveBeenCalledTimes(2)
    expect(h.session.getSnapshot()).toEqual({ state: "ok" })
    expect(h.resume).toHaveBeenCalledTimes(1)

    // Back at ok there is no re-probe, and another ok does not resume again.
    h.advanceVisible(REPROBE_VISIBLE_MS * 4)
    await vi.advanceTimersByTimeAsync(REPROBE_VISIBLE_MS * 4)
    expect(h.fetchMock).toHaveBeenCalledTimes(2)
    h.queue(identity)
    h.session.noteRequestTrouble()
    await vi.advanceTimersByTimeAsync(10)
    expect(h.resume).toHaveBeenCalledTimes(1)
  })

  it("keeps its verdict on an unreachable probe", async () => {
    const h = harness()
    h.queue(unauthorized)
    h.session.noteRequestTrouble()
    await vi.advanceTimersByTimeAsync(10)
    h.advanceVisible(REPROBE_VISIBLE_MS)
    await vi.advanceTimersByTimeAsync(REPROBE_VISIBLE_MS)
    expect(h.fetchMock).toHaveBeenCalledTimes(2)
    expect(h.session.getSnapshot().state).toBe("signin_needed")
  })

  it("never guesses sign-in from unreachable probes while the fallback is off", async () => {
    const h = harness()
    for (let i = 0; i < 5; i++) {
      h.session.noteConnectionTrouble()
      await vi.advanceTimersByTimeAsync(MIN_PROBE_GAP_MS)
    }
    expect(h.fetchMock).toHaveBeenCalledTimes(5)
    expect(h.session.getSnapshot()).toEqual({ state: "ok" })
  })

  it("G3 fallback: three unreachable probes on the cloud hostname read as signin_maybe", async () => {
    const h = harness({ g3Fallback: true })
    for (let i = 0; i < 3; i++) {
      h.session.noteConnectionTrouble()
      await vi.advanceTimersByTimeAsync(MIN_PROBE_GAP_MS)
    }
    expect(h.session.getSnapshot()).toEqual({ state: "signin_maybe" })
  })

  it("G3 fallback stays quiet off the cloud hostname or while offline", async () => {
    for (const over of [
      { pageHostname: () => "127.0.0.1" },
      { online: () => false },
    ] as Partial<AccessSessionDeps>[]) {
      const h = harness({ g3Fallback: true, ...over })
      for (let i = 0; i < 4; i++) {
        h.session.noteConnectionTrouble()
        await vi.advanceTimersByTimeAsync(MIN_PROBE_GAP_MS)
      }
      expect(h.session.getSnapshot()).toEqual({ state: "ok" })
    }
  })
})

describe("close codes", () => {
  it("keeps 4001 and 4401 equal to registry/close-codes.json", () => {
    const reg = JSON.parse(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "../../../../../../cloud/protocol/registry/close-codes.json",
        ),
        "utf8",
      ),
    ) as { close_codes: { code: number; reason: string | null }[] }
    const byCode = new Map(reg.close_codes.map((c) => [c.code, c.reason]))
    expect(byCode.get(ACCESS_SESSION_EXPIRED_CLOSE)).toBe("access session expired")
    expect(byCode.has(PROVIDER_UNAVAILABLE_CLOSE)).toBe(true)
    expect(byCode.get(PROVIDER_UNAVAILABLE_CLOSE)).toBeNull()
  })
})
