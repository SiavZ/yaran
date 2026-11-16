import { describe, expect, it, vi } from "vitest"

let bootstrap: unknown = null
let native = false
vi.mock("@/lib/store", () => ({ useYaran: () => ({ bootstrap }) }))
vi.mock("@/lib/native/nativeShell", () => ({ isNativeShell: () => native }))
let sessionToEnd = false
vi.mock("@/lib/authGate", () => ({
  useAuthPhase: () => "open",
  hasSessionToEnd: () => sessionToEnd,
}))

const { useAppMenuContext } = await import("./useAppMenuContext")

describe("useAppMenuContext", () => {
  it("offers the phone QR on a paired machine in a browser only", () => {
    bootstrap = { cloud: { paired: true } }
    native = false
    expect(useAppMenuContext()).toMatchObject({ nativeShell: false, phonePairing: true })
    native = true
    expect(useAppMenuContext()).toMatchObject({ nativeShell: true, phonePairing: false })
  })

  it("defaults every field when the server sends no cloud projection", () => {
    bootstrap = {}
    native = false
    expect(useAppMenuContext()).toEqual({
      ghAvailable: false,
      githubIntegrationEnabled: false,
      nativeShell: false,
      phonePairing: false,
      canSignOut: false,
    })
  })

  it("offers Sign out only where this page holds a session to end", () => {
    bootstrap = {}
    sessionToEnd = true
    expect(useAppMenuContext()).toMatchObject({ canSignOut: true })
    sessionToEnd = false
    expect(useAppMenuContext()).toMatchObject({ canSignOut: false })
  })
})
