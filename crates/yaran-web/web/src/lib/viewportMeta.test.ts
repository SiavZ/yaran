import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// Pins the shipped viewport meta in index.html. Every directive on it is
// deliberate and was measured on real devices before it shipped; this test is
// where the reasoning lives, so editing the meta means reading this first.
//
//  - interactive-widget=resizes-content: the soft keyboard shrinks the LAYOUT
//    viewport (and window.visualViewport.height with it), so the mobile shell
//    pins to that height and the terminal plus accessory bar sit flush on the
//    keyboard with no per-pane keyboard math. Without it, Chromium/Android
//    still counts the keyboard's toolbar strip in visualViewport.height and
//    the bottom accessory row renders behind the keyboard. Chromium-only;
//    iOS and Firefox fall back to the same (already accurate) visualViewport
//    handling.
//  - viewport-fit=cover: lets the page draw under the notch and home
//    indicator AND is what makes env(safe-area-inset-*) report real values
//    (they are 0 without it). The mobile root's env() padding in App.tsx and
//    the fullscreen terminal column in TerminalPane.tsx depend on it.
//  - No maximum-scale/user-scalable restriction: touch inputs use at least
//    16px type to prevent Safari focus zoom without restricting user zoom.
//  - width=device-width, initial-scale=1.0: the ordinary responsive base the
//    directives above compose with.
const html = readFileSync(
  fileURLToPath(new URL("../../index.html", import.meta.url)),
  "utf8",
)

describe("index.html viewport meta", () => {
  const metaLines = html
    .split("\n")
    .filter((l) => l.includes('name="viewport"'))
  const meta = metaLines[0]

  it("ships exactly one viewport meta line", () => {
    expect(metaLines).toHaveLength(1)
  })

  it("keeps the keyboard-resize directive", () => {
    expect(meta).toContain("interactive-widget=resizes-content")
  })

  it("keeps viewport-fit=cover so safe-area insets report real values", () => {
    expect(meta).toContain("viewport-fit=cover")
  })

  it("allows users to zoom without a scale limit", () => {
    expect(meta).not.toMatch(/maximum-scale|user-scalable/)
  })

  it("keeps the responsive base directives", () => {
    expect(meta).toContain("width=device-width")
    expect(meta).toContain("initial-scale=1.0")
  })
})
