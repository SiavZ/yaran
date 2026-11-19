// @vitest-environment jsdom
/**
 * The sign-in gate inside the phone app: the server-served page never takes the password there.
 * Whatever signed the page out, the app's user agent (read by the real, strict parser; a
 * presentation hint, never an authority) gets a Sign in that navigates to the strict
 * `yaranapp://reauth` URL the native window answers with its own sheet, and no password field.
 * A browser, and a look-alike user agent, keep the login form.
 *
 * <module-headers:begin>
 * <module-headers:end>
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import type { AuthStatus } from "@/lib/authApi"
import type { AuthPhase } from "@/lib/authGate"

let phase: AuthPhase = { kind: "checking" }
vi.mock("@/lib/authGate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authGate")>()
  return { ...actual, useAuthPhase: () => phase, refreshAuthStatus: vi.fn(async () => {}), retryAuthGate: vi.fn(async () => {}) }
})
vi.mock("@yaran/ui-kit/sonner", () => ({ Toaster: () => <section data-testid="toaster" /> }))
vi.mock("@/lib/store", () => ({ openCustomizeWebapp: vi.fn() }))
vi.mock("@/lib/notify", () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }))

const { AuthGate } = await import("./AuthGate")
const { resetNativeShellForTest } = await import("@/lib/native/nativeShell")

function status(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return {
    password_set: true,
    required_here: true,
    signed_in: false,
    client_class: "network",
    transport_encrypted: true,
    no_auth_warning: false,
    weak_password: false,
    can_set_first_password: false,
    auth_broken: null,
    minimum_password_length: null,
    minimum_password_score: null,
    ...overrides,
  }
}

function renderGate() {
  return render(
    <AuthGate>
      <div>the app</div>
    </AuthGate>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// Inside the phone app (its user agent, read by the real parser) the password belongs to the
// app's native sheet: whatever signed the page out, no password field, and Sign in goes to the
// strict control URL. A browser still gets the login form.
describe("in the phone app", () => {
  const HOST = "laptop-ada.example.com"
  const assign = vi.fn()
  const asApp = (ua: string) => {
    vi.stubGlobal("navigator", { userAgent: ua })
    vi.stubGlobal("location", { ...window.location, hostname: HOST, host: `${HOST}:8443`, assign })
    resetNativeShellForTest()
  }
  afterEach(() => {
    vi.unstubAllGlobals()
    resetNativeShellForTest()
  })

  it.each(["required", "expired", "signed_out", "password_changed"] as const)(
    "signed out (%s): a native Sign in to the reauth URL and no password field",
    (reason) => {
      asApp("Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/131.0 Mobile YaranApp/1.2.3 (android; phone)")
      phase = { kind: "signed_out", status: status({ password_set: true, required_here: true }), reason }
      const { container } = renderGate()
      expect(container.ownerDocument.querySelector("input")).toBeNull()
      expect(screen.queryByLabelText("Password")).toBeNull()
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }))
      expect(assign).toHaveBeenCalledWith(`yaranapp://reauth?host=${HOST}`)
    },
  )

  it("a browser, or a look-alike user agent, still gets the password form", () => {
    for (const ua of ["Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0", "Mozilla/5.0 YaranApp/1.2 (android; phone)"]) {
      asApp(ua)
      phase = { kind: "signed_out", status: status({ password_set: true, required_here: true }), reason: "expired" }
      renderGate()
      expect(screen.getByLabelText("Password")).toBeTruthy()
      cleanup()
    }
  })
})
