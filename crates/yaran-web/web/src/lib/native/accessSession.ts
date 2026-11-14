/**
 * Access-session state machine: tells "your Cloudflare Access sign-in expired" apart from
 * "the server is down", so the offline overlay can offer the right way back.
 *
 * A trigger (a failed socket attempt, a request answered by a login page, a 4401 close)
 * asks for one probe of `/api/v1/build` with `redirect: "manual"`; `classifyProbe` reads
 * the answer, with `Yaran-Refusal` codes from Phase 02's registry taking precedence over
 * the status. While the verdict is not `ok` the module re-probes every few seconds of
 * VISIBLE time; on the way back to `ok` it resumes the events socket once.
 *
 * - Module-level store with `subscribe`/`getSnapshot`, so `store.ts` gains no fields.
 * - Probes coalesce: one in flight, a minimum gap between them.
 * - Trust boundary: the refusal header is matched against a closed list, never echoed.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/native/accessSession.ts
 * ├── src/lib/assertNever.ts
 * └── src/lib/visibleClock.ts
 * External: react
 *
 * Used by:
 * src/lib/native/accessSession.ts
 * ├── src/components/OfflineOverlay.dom.test.tsx
 * ├── src/components/OfflineOverlay.tsx
 * ├── src/lib/eventsSocket.test.ts
 * ├── src/lib/eventsSocket.ts
 * ├── src/lib/jsonRequest.test.ts
 * ├── src/lib/jsonRequest.ts
 * ├── src/lib/native/accessFace.ts
 * ├── src/lib/native/accessSession.test.ts
 * ├── src/lib/ptySocket.test.ts
 * ├── src/lib/ptySocket.ts
 * └── src/lib/store.ts
 * <module-headers:end>
 */
import { useSyncExternalStore } from "react"

import { assertNever } from "@/lib/assertNever"
import { createVisibleClock, type VisibleClock } from "@/lib/visibleClock"

/** Phase 02's `registry/refusals.json`, in registry order. A test pins the two together. */
export const REFUSAL_CODES = [
  "access-missing",
  "access-malformed",
  "access-bad-algorithm",
  "access-unknown-kid",
  "access-bad-signature",
  "access-wrong-issuer",
  "access-wrong-audience",
  "access-expired",
  "access-not-yet-valid",
  "access-not-app-token",
  "access-service-token",
  "access-not-owner",
  "access-keys-unavailable",
  "host-not-served",
  "host-missing",
] as const
export type RefusalCode = (typeof REFUSAL_CODES)[number]
export type ServerRefusal = "access-keys-unavailable" | "host-not-served" | "host-missing"
export const REFUSAL_HEADER = "Yaran-Refusal"
/** Phase 02's `SESSION_EXPIRED_CLOSE_CODE` (`registry/close-codes.json`), sent by Phase 11. */
export const ACCESS_SESSION_EXPIRED_CLOSE = 4401

/** What the probe saw, reduced to the facts the classifier reads. */
export type ProbeResult =
  | { kind: "threw" }
  | {
      kind: "response"
      type: ResponseType
      status: number
      refusal: string | null
      contentType: string
      body: string
    }

export type ProbeOutcome =
  | { kind: "ok" }
  | { kind: "signin_needed"; refusal: RefusalCode | null }
  | { kind: "server_problem"; refusal: ServerRefusal }
  | { kind: "unreachable" }

/** What the overlay renders. `ok` means no sign-in or server problem is known. */
export type AccessSnapshot =
  | { state: "ok" }
  | { state: "signin_needed"; refusal: RefusalCode | null }
  | { state: "signin_maybe" }
  | { state: "server_problem"; refusal: ServerRefusal }

const isRefusal = (code: string): code is RefusalCode =>
  (REFUSAL_CODES as readonly string[]).includes(code)

function looksLikeIdentity(body: string): boolean {
  try {
    const v = JSON.parse(body) as { version?: unknown; process?: unknown }
    return typeof v?.version === "string" && typeof v?.process === "string"
  } catch {
    return false
  }
}

/** The §2 table, top to bottom; the first matching row decides. */
export function classifyProbe(result: ProbeResult): ProbeOutcome {
  if (result.kind === "threw") return { kind: "unreachable" }
  if (result.type === "opaqueredirect") return { kind: "signin_needed", refusal: null }
  const code = result.refusal?.trim() ?? ""
  if (isRefusal(code)) {
    switch (code) {
      case "access-keys-unavailable":
      case "host-not-served":
      case "host-missing":
        return { kind: "server_problem", refusal: code }
      default:
        return { kind: "signin_needed", refusal: code }
    }
  }
  // No header, or a code this build does not know: the status decides (02 §13).
  if (result.status === 401 || result.status === 403) {
    return { kind: "signin_needed", refusal: null }
  }
  if (result.status === 200) {
    return looksLikeIdentity(result.body)
      ? { kind: "ok" }
      : { kind: "signin_needed", refusal: null }
  }
  return { kind: "unreachable" }
}

/**
 * G3 fallback. Primary path: off. Flip to true if G3 shows Access answers an expired
 * fetch with neither a 401 nor an observable `opaqueredirect`.
 */
export const G3_SIGNIN_MAYBE_FALLBACK = false
const SIGNIN_MAYBE_AFTER_UNREACHABLE = 3
export const REPROBE_VISIBLE_MS = 5000
export const MIN_PROBE_GAP_MS = 2000

export type AccessSessionDeps = {
  fetch: typeof fetch
  now: () => number
  clock: VisibleClock
  /** Resume the events socket after a recognised sign-in. */
  resume: () => void
  /** `bootstrap.cloud?.hostname`, for the G3 fallback's "only on the cloud hostname". */
  cloudHostname: () => string | null | undefined
  pageHostname: () => string
  online: () => boolean
  g3Fallback: boolean
}

async function runProbe(f: typeof fetch): Promise<ProbeResult> {
  try {
    const resp = await f("/api/v1/build", {
      redirect: "manual",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    })
    return {
      kind: "response",
      type: resp.type,
      status: resp.status,
      refusal: resp.headers.get(REFUSAL_HEADER),
      contentType: resp.headers.get("content-type") ?? "",
      body: await resp.text().catch(() => ""),
    }
  } catch {
    return { kind: "threw" }
  }
}

export function createAccessSession(deps: AccessSessionDeps) {
  let snapshot: AccessSnapshot = { state: "ok" }
  const listeners = new Set<() => void>()
  let inFlight = false
  let lastProbeEnd = Number.NEGATIVE_INFINITY
  let gapTimer: ReturnType<typeof setTimeout> | null = null
  let reprobeTimer: ReturnType<typeof setTimeout> | null = null
  let unreachableStreak = 0

  const set = (next: AccessSnapshot) => {
    snapshot = next
    for (const l of [...listeners]) l()
  }

  const armReprobe = () => {
    if (reprobeTimer !== null || snapshot.state === "ok") return
    const left = Math.max(0, REPROBE_VISIBLE_MS - deps.clock.elapsedMs())
    // Hidden time does not count: the timer may fire early and simply re-arm for the rest.
    reprobeTimer = setTimeout(() => {
      reprobeTimer = null
      if (snapshot.state === "ok") return
      if (deps.clock.elapsedMs() >= REPROBE_VISIBLE_MS) probe()
      else armReprobe()
    }, Math.max(left, 250))
  }

  const apply = (outcome: ProbeOutcome) => {
    const was = snapshot.state
    switch (outcome.kind) {
      case "ok":
        unreachableStreak = 0
        if (was !== "ok") {
          set({ state: "ok" })
          deps.resume()
        }
        return
      case "signin_needed":
        unreachableStreak = 0
        set({ state: "signin_needed", refusal: outcome.refusal })
        break
      case "server_problem":
        unreachableStreak = 0
        set({ state: "server_problem", refusal: outcome.refusal })
        break
      case "unreachable":
        // No news about the session: keep the current verdict, except the G3 fallback.
        unreachableStreak++
        if (
          deps.g3Fallback &&
          was === "ok" &&
          unreachableStreak >= SIGNIN_MAYBE_AFTER_UNREACHABLE &&
          deps.online() &&
          deps.pageHostname() === deps.cloudHostname()
        ) {
          set({ state: "signin_maybe" })
        }
        break
      default:
        assertNever(outcome)
    }
    if (was === "ok" && snapshot.state !== "ok") deps.clock.reset()
  }

  const probe = (): void => {
    if (inFlight) return
    const wait = lastProbeEnd + MIN_PROBE_GAP_MS - deps.now()
    if (wait > 0) {
      if (gapTimer === null) {
        gapTimer = setTimeout(() => {
          gapTimer = null
          probe()
        }, wait)
      }
      return
    }
    inFlight = true
    void runProbe(deps.fetch).then((result) => {
      inFlight = false
      lastProbeEnd = deps.now()
      deps.clock.reset()
      apply(classifyProbe(result))
      armReprobe()
    })
  }

  return {
    getSnapshot: (): AccessSnapshot => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Trigger (a): an events-socket attempt failed or dropped. */
    noteConnectionTrouble: probe,
    /** Trigger (b): a request threw, got 401/403, or got a page instead of JSON. */
    noteRequestTrouble: probe,
    /** Trigger (c): a socket closed with 4401. */
    noteSessionExpired: probe,
    /** The overlay's Reconnect: ask again now rather than on the next tick. */
    recheck: probe,
  }
}

export type AccessSession = ReturnType<typeof createAccessSession>

let configured: Pick<AccessSessionDeps, "resume" | "cloudHostname"> = {
  resume: () => {},
  cloudHostname: () => null,
}

// Built on first use, not at import: some harnesses stub a partial `document`.
let pageClock: VisibleClock | null = null
const clock = () => (pageClock ??= createVisibleClock())

/** The page's one machine. `store.ts` supplies the two things only it knows. */
export const accessSession = createAccessSession({
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  clock: {
    elapsedMs: () => clock().elapsedMs(),
    reset: () => clock().reset(),
    dispose: () => pageClock?.dispose(),
  },
  resume: () => configured.resume(),
  cloudHostname: () => configured.cloudHostname(),
  pageHostname: () => (typeof location === "undefined" ? "" : location.hostname),
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
  g3Fallback: G3_SIGNIN_MAYBE_FALLBACK,
})

export function configureAccessSession(next: typeof configured): void {
  configured = next
}

export function useAccessSession(): AccessSnapshot {
  return useSyncExternalStore(accessSession.subscribe, accessSession.getSnapshot)
}
