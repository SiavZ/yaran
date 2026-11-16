// Turns `config.server.favicon` into the favicon the browser shows: unset gives
// the bundled full-colour Yaran mark, a curated colour name gives the Yaran mark silhouette
// tinted with it as an inline SVG data URI.
//
// Only a curated colour name is accepted; a hex, a URL or a dropped name
// degrades to the default Yaran mark. The colour reaching the generated SVG is always
// a validated `#rrggbb` from the map below, so nothing untrusted is
// interpolated into the markup.

import {
  createWakeTimer,
  startAttentionBlink,
  type AttentionBlink,
} from "./faviconBlink"
import { notifyInfo } from "./notify"
import { chip, prose } from "./prose"

// The branching Y silhouette matches assets/yaran-logo.svg. It has no cutout
// features or nondeterministic raster trace.
export const BRAND_PATH = "M120 104 256 240 392 104 432 144 284 292V432H228V292L80 144Z"
const BRAND_VIEWBOX = "0 0 512 512"

/** The bundled default favicon served from `public/` (the full-colour Yaran mark). */
export const DEFAULT_FAVICON_HREF = "/favicon.png"

// The curated tint colours, which must equal `CURATED_FAVICON_COLORS` in
// `crates/yaran-core/src/wire.rs`. No yellow: that is the unset default Yaran mark's own
// colour, so it is reserved rather than selectable.
export const FAVICON_COLORS: Record<string, string> = {
  violet: "#863bff",
  blue: "#3b82f6",
  sky: "#0ea5e9",
  cyan: "#06b6d4",
  teal: "#14b8a6",
  green: "#22c55e",
  amber: "#f59e0b",
  orange: "#f97316",
  red: "#ef4444",
  pink: "#ec4899",
  rose: "#f43f5e",
}

// The safe fallback fill for the defense-in-depth clamp in `brandFaviconDataUri`.
const DEFAULT_TINT = FAVICON_COLORS.violet

const HEX_RE = /^#[0-9a-f]{6}$/

// The set of valid hex fills (the curated values). Nothing else is ever
// interpolated into the generated SVG.
const VALID_FILLS = new Set(Object.values(FAVICON_COLORS))

export type FaviconResolution =
  | { kind: "default" }
  | { kind: "tinted"; color: string }

/**
 * Resolve `config.server.favicon` into what the UI shows. A curated colour name
 * yields a normalized `#rrggbb`, safe to inline into SVG; blank and anything
 * uncurated yield the bundled Yaran mark.
 */
export function resolveFavicon(
  raw: string | null | undefined,
): FaviconResolution {
  const value = (raw ?? "").trim().toLowerCase()
  if (value === "") return { kind: "default" }

  const named = FAVICON_COLORS[value]
  if (named) return { kind: "tinted", color: named }

  // Non-empty but not a curated name (a legacy hex/URL/dropped name) → default.
  return { kind: "default" }
}

/**
 * Build an inline SVG `data:` URI of the Yaran mark silhouette filled in `color`, which
 * must already be a validated hex from `resolveFavicon`. Anything else is
 * replaced by the default fill, so no unsanitized string can break out of the
 * `fill` attribute.
 */
export function brandFaviconDataUri(color: string): string {
  const fill = HEX_RE.test(color) && VALID_FILLS.has(color) ? color : DEFAULT_TINT
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BRAND_VIEWBOX}">` +
    `<path fill="${fill}" fill-rule="evenodd" d="${BRAND_PATH}"/>` +
    `</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/**
 * Resolve the configured favicon to the `href` to apply and whether it is an SVG,
 * so the caller can set the matching `type`.
 */
export function faviconHref(raw: string | null | undefined): {
  href: string
  svg: boolean
} {
  const resolved = resolveFavicon(raw)
  if (resolved.kind === "tinted") {
    return { href: brandFaviconDataUri(resolved.color), svg: true }
  }
  return { href: DEFAULT_FAVICON_HREF, svg: false }
}

/**
 * Whether `raw` is a non-empty value that is not a curated colour name. Such
 * values render the default Yaran mark, and `applyFavicon` announces that once.
 */
export function faviconIsLegacy(raw: string | null | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase()
  if (value === "") return false
  return FAVICON_COLORS[value] === undefined
}

// The last legacy value announced, or null when the current favicon is curated
// or empty. `config.changed` re-applies the favicon on every rename, so the same
// bad value must not notify twice while a different one still must.
let lastNoticedLegacy: string | null = null

/**
 * Apply the configured favicon by replacing the `<link rel="icon">`, which is
 * what browsers reliably pick up. A no-op without a real DOM, and a legacy value
 * raises the one-time notice. It touches the DOM only when the resolved favicon
 * changed: re-creating an identical `<link>` flashes the tab icon, and
 * `config.changed` fires on every unrelated rename.
 */
export function applyFavicon(raw: string | null | undefined): void {
  if (typeof document === "undefined") return
  if (typeof document.createElement !== "function" || !document.head) return

  if (faviconIsLegacy(raw)) {
    if (raw !== lastNoticedLegacy) {
      lastNoticedLegacy = raw ?? null
      notifyInfo(
        prose`The configured favicon ${chip((raw ?? "").trim())} is no longer supported, showing the default Yaran mark. Pick a color in the Preferences dialog, opened from the cog menu in the top-right.`,
      )
    }
  } else {
    // A curated or empty value clears the latch so a later bad value notifies.
    lastNoticedLegacy = null
  }

  const { href, svg } = faviconHref(raw)
  // A concrete MIME for both, never null, so it matches the static
  // `<link type="image/png">` in index.html and the diff below can
  // short-circuit on first load.
  const type = svg ? "image/svg+xml" : "image/png"

  // Skip the remove+recreate when the resolved favicon is unchanged, so an
  // unrelated `config.changed` doesn't flash the tab icon.
  const current = document.querySelector("link[rel='icon']")
  if (
    current &&
    current.getAttribute("href") === href &&
    current.getAttribute("type") === type
  ) {
    return
  }

  setIconLink(href, type)
}

/** Replace the `<link rel="icon">` element with one pointing at `href`. Callers
 * must have confirmed a real DOM and that the target differs from the current
 * icon. */
function setIconLink(href: string, type: string): void {
  document.querySelectorAll("link[rel='icon']").forEach((el) => el.remove())

  const link = document.createElement("link")
  link.setAttribute("rel", "icon")
  link.setAttribute("type", type)
  link.setAttribute("href", href)
  document.head.appendChild(link)
}

// The attention dot and its dark rim, for contrast against the Yaran mark. The fill is
// Tailwind cyan-100, the same cyan `AttentionDot` paints with `bg-cyan-100`; a
// canvas cannot read a class, so keep the two in lockstep by hand.
const ATTENTION_DOT_FILL = "#cffafe"
const ATTENTION_DOT_RIM = "#1a1a1a"

// The two frames the favicon blinks between: the dot at full strength, and the
// icon with no dot at all, because a dot faded to the row dot's floor still
// reads as a dot at favicon size. Both are PNG data URLs.
type DotFrames = { on: string; dim: string }

// Composed frame pairs, keyed by the base href, so a base is drawn onto a
// canvas once and the blink only ever swaps finished URLs.
const dotFramesCache = new Map<string, DotFrames>()
// Bases whose frames are being composed, so the store's repeat calls during a
// compose do not start another one.
const composing = new Set<string>()
// The base href whose dotted variant is wanted, or null for the clean icon. Set
// synchronously, so an async compose resolving after a clear cannot stomp it.
let wantedDotBase: string | null = null
// The data URL currently on the `<link>` via the attention path, so a frame
// that is already shown doesn't touch the DOM.
let appliedDottedIcon: string | null = null
// The running blink and the base it blinks, or null when none runs (no
// attention, reduced motion, or frames not composed yet).
let blink: { base: string; handle: AttentionBlink } | null = null
// The reduced-motion query being listened to while a dot is wanted.
let motionQuery: MediaQueryList | null = null

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

/**
 * Composite the current favicon with a corner dot that blinks on the row dot's
 * period and two-dip shape (`attentionPulse.ts`, driven by `faviconBlink.ts`),
 * or restore the clean icon. Reduced motion holds the dot steady, like the row dot. Idempotent:
 * each base's frames are composed once, a repeat call while attention holds
 * leaves the running blink alone, and clearing stops the blink and its clock
 * before restoring the configured favicon. Without a DOM or a working
 * `<canvas>` it leaves the clean icon in place rather than throwing, and the
 * browser-tab count still says it.
 */
export function applyAttentionFavicon(
  raw: string | null | undefined,
  hasAttention: boolean,
): void {
  if (typeof document === "undefined") return
  if (typeof document.createElement !== "function" || !document.head) return

  if (!hasAttention) {
    // Stop the blink and its clock, then restore the clean base icon.
    stopAttentionMotion()
    wantedDotBase = null
    appliedDottedIcon = null
    applyFavicon(raw)
    return
  }

  const { href } = faviconHref(raw)
  wantedDotBase = href

  const cached = dotFramesCache.get(href)
  if (cached) {
    showDottedFavicon(href, cached)
    return
  }
  // The favicon changed and its frames are not drawn yet: the old tint's blink
  // must not carry on meanwhile, nor forever if the drawing fails. Show the new
  // plain favicon until its dotted frames are ready.
  if (blink && blink.base !== href) stopBlink()
  if (appliedDottedIcon !== null) {
    appliedDottedIcon = null
    applyFavicon(raw)
  }
  if (composing.has(href)) return
  composing.add(href)

  composeDotFrames(href)
    .then((frames) => {
      if (!frames) return
      dotFramesCache.set(href, frames)
      // Only apply while the dot is still wanted for this base: a clear or a
      // base change may have landed during the compositing.
      if (wantedDotBase === href) showDottedFavicon(href, frames)
    })
    .catch((err) => {
      // Leave the clean icon in place on any compositing failure; the
      // browser-tab count still conveys the state.
      console.warn("[yaran] favicon attention dot failed; keeping clean icon", err)
    })
    .finally(() => {
      composing.delete(href)
    })
}

/** Show `href`'s dotted frames: a steady dot under reduced motion, otherwise
 * the blink (left running when it already blinks this base). */
function showDottedFavicon(href: string, frames: DotFrames): void {
  watchReducedMotion()
  if (prefersReducedMotion()) {
    stopBlink()
    setDottedIcon(frames.on)
    return
  }
  if (blink?.base === href) return
  stopBlink()
  blink = {
    base: href,
    handle: startAttentionBlink({
      timer: createWakeTimer(),
      show: (frame) => setDottedIcon(frames[frame]),
      hidden: () => document.visibilityState === "hidden",
    }),
  }
  document.addEventListener("visibilitychange", onVisibilityChange)
}

function setDottedIcon(url: string): void {
  if (appliedDottedIcon === url) return
  setIconLink(url, "image/png")
  appliedDottedIcon = url
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  )
}

// Follow the reduced-motion preference live while a dot is wanted, so turning
// it on stills a running blink and turning it off starts one.
function watchReducedMotion(): void {
  if (motionQuery) return
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
  motionQuery = window.matchMedia(REDUCED_MOTION_QUERY)
  if (typeof motionQuery.addEventListener === "function") {
    motionQuery.addEventListener("change", onReducedMotionChange)
  } else {
    // Safari before 14 only has the deprecated MediaQueryList listener pair.
    motionQuery.addListener?.(onReducedMotionChange)
  }
}

function unwatchReducedMotion(): void {
  if (!motionQuery) return
  if (typeof motionQuery.removeEventListener === "function") {
    motionQuery.removeEventListener("change", onReducedMotionChange)
  } else {
    motionQuery.removeListener?.(onReducedMotionChange)
  }
  motionQuery = null
}

function onReducedMotionChange(): void {
  const base = wantedDotBase
  const frames = base === null ? undefined : dotFramesCache.get(base)
  if (base !== null && frames) showDottedFavicon(base, frames)
}

// A hidden page switches to the blink its throttled clock can keep, and a
// page coming back plays the full rhythm again.
function onVisibilityChange(): void {
  blink?.handle.resync()
}

function stopBlink(): void {
  if (!blink) return
  blink.handle.stop()
  blink = null
  document.removeEventListener("visibilitychange", onVisibilityChange)
}

function stopAttentionMotion(): void {
  stopBlink()
  unwatchReducedMotion()
}

/** Draw the base favicon onto a canvas once with a cyan corner dot and once
 * without, and return both as PNG data URLs, or
 * `null` when canvas/image loading is unavailable (e.g. jsdom). */
function composeDotFrames(href: string): Promise<DotFrames | null> {
  return new Promise((resolve) => {
    const size = 64
    const canvas = document.createElement("canvas")
    canvas.width = size
    canvas.height = size
    const ctx =
      typeof canvas.getContext === "function"
        ? (canvas.getContext("2d") as CanvasRenderingContext2D | null)
        : null
    if (!ctx) {
      resolve(null)
      return
    }
    const img = new Image()
    const draw = (withDot: boolean): string => {
      ctx.clearRect(0, 0, size, size)
      ctx.globalAlpha = 1
      ctx.drawImage(img, 0, 0, size, size)
      if (!withDot) return canvas.toDataURL("image/png")
      const r = size * 0.26
      const cx = size - r - size * 0.05
      const cy = size - r - size * 0.05
      // Dark rim first for contrast against the Yaran mark, then the cyan fill.
      ctx.beginPath()
      ctx.arc(cx, cy, r + size * 0.06, 0, Math.PI * 2)
      ctx.fillStyle = ATTENTION_DOT_RIM
      ctx.fill()
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.fillStyle = ATTENTION_DOT_FILL
      ctx.fill()
      return canvas.toDataURL("image/png")
    }
    img.onload = () => {
      try {
        const on = draw(true)
        const dim = draw(false)
        resolve({ on, dim })
      } catch (err) {
        console.warn("[yaran] favicon dot compositing failed", err)
        resolve(null)
      }
    }
    img.onerror = (err) => {
      console.warn("[yaran] favicon base image failed to load for dot compositing", err)
      resolve(null)
    }
    img.src = href
  })
}
