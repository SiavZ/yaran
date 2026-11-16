import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { deviceLabel } from "./deviceLabel"

// The fixture `device_label.rs` reads too, so the two surfaces cannot drift.
const fixture = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../yaran-core/tests/fixtures/device_label_cross_language.json",
    ),
    "utf8",
  ),
) as { cases: { ua: string; label: string }[] }
const byLabel = (label: string) => fixture.cases.find((c) => c.label === label)!.ua
const UA = {
  chromeAndroid: byLabel("Chrome on Android"),
  safariIphone: byLabel("Safari on iOS"),
  unknownBrowserWindows: byLabel("Windows"),
}

describe("deviceLabel", () => {
  // The yaran terminal UI drives PTYs too while a background server is serving,
  // and it is not a browser: it records a fixed label rather than a User-Agent.
  // That label parses as no OS, so without the exact-match rule the one
  // non-browser driver yaran has would show on every card as "another device".
  it("names the yaran terminal UI as itself", () => {
    expect(deviceLabel("the yaran TUI")).toBe("the yaran TUI")
  })

  // The exact match is exact on purpose: the User-Agent is attacker-controllable
  // and this value becomes copy, so nothing else unrecognized may pass through.
  it("still refuses every other unrecognized string", () => {
    expect(deviceLabel("the yaran TUI and also this")).toBeNull()
    expect(deviceLabel("The Yaran Tui")).toBeNull()
    expect(deviceLabel("<script>alert(1)</script>")).toBeNull()
  })

  it.each(fixture.cases)("labels $ua as $label", ({ ua, label }) => {
    expect(deviceLabel(ua)).toBe(label)
  })

  it("fits every fixture label in the 24 characters the card has", () => {
    for (const { label } of fixture.cases) {
      expect(Array.from(label).length).toBeLessThanOrEqual(24)
    }
  })

  it("returns null for unknown, empty, or missing input", () => {
    expect(deviceLabel("totally unrecognizable string")).toBeNull()
    expect(deviceLabel("")).toBeNull()
    expect(deviceLabel("   ")).toBeNull()
    expect(deviceLabel(null)).toBeNull()
    expect(deviceLabel(undefined)).toBeNull()
  })

  it("falls back to OS-only when the OS is known but the browser is not", () => {
    expect(deviceLabel(UA.unknownBrowserWindows)).toBe("Windows")
  })

  it("orders OS checks so Android beats Linux and iOS beats macOS", () => {
    // Android UA also contains "Linux".
    expect(deviceLabel(UA.chromeAndroid)).toContain("Android")
    // iPhone UA also contains "like Mac OS X".
    expect(deviceLabel(UA.safariIphone)).toContain("iOS")
  })
})
