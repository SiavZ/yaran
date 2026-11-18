import { describe, expect, it } from "vitest"

import { noteServerRunProbe, onServerRunUnconfirmed } from "./serverRun"

describe("the run-identity fan-out", () => {
  it("says nothing at all when the run is the same", () => {
    const seen: string[] = []
    const off = onServerRunUnconfirmed(() => seen.push("unconfirmed"))
    noteServerRunProbe("same")
    off()
    expect(seen).toEqual([])
  })

  it("speaks up for a confirmed change and for a probe that could not answer", () => {
    const seen: string[] = []
    const off = onServerRunUnconfirmed(() => seen.push("unconfirmed"))
    noteServerRunProbe("changed")
    noteServerRunProbe("unknown")
    off()
    expect(seen).toEqual(["unconfirmed", "unconfirmed"])
  })

  it("stops calling a listener that unsubscribed", () => {
    let calls = 0
    const off = onServerRunUnconfirmed(() => {
      calls++
    })
    off()
    noteServerRunProbe("changed")
    expect(calls).toBe(0)
  })
})
