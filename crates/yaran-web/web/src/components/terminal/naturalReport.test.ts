import { describe, expect, it } from "vitest"

import { createNaturalReport, type Grid } from "./naturalReport"

function setup(opts: { reports?: boolean; wire?: boolean } = {}) {
  const sent: Grid[] = []
  let natural: Grid | null = { rows: 50, cols: 160 }
  let reports = opts.reports ?? true
  let wire = opts.wire ?? true
  const report = createNaturalReport({
    reports: () => reports,
    naturalGrid: () => natural,
    sendResize: (rows, cols) => {
      if (!wire) return false
      sent.push({ rows, cols })
      return true
    },
  })
  return {
    report,
    sent,
    setNatural: (g: Grid | null) => {
      natural = g
    },
    setReports: (v: boolean) => {
      reports = v
    },
    setWire: (v: boolean) => {
      wire = v
    },
  }
}

describe("the natural-grid report", () => {
  it("sends the natural grid, and only again once it moved", () => {
    const { report, sent, setNatural } = setup()
    expect(report.report(false)).toBe(true)
    expect(report.report(false)).toBe(false)
    setNatural({ rows: 30, cols: 90 })
    expect(report.report(false)).toBe(true)
    expect(sent).toEqual([
      { rows: 50, cols: 160 },
      { rows: 30, cols: 90 },
    ])
  })

  it("re-sends an unchanged grid when forced", () => {
    const { report, sent } = setup()
    report.report(false)
    expect(report.report(true)).toBe(true)
    expect(sent).toHaveLength(2)
  })

  it("sends nothing while it may not report: holding the size, hidden or off screen", () => {
    const { report, sent, setReports } = setup({ reports: false })
    expect(report.report(true)).toBe(false)
    setReports(true)
    expect(report.report(false)).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it("sends nothing when the grid cannot be measured", () => {
    const { report, sent, setNatural } = setup()
    setNatural(null)
    expect(report.report(true)).toBe(false)
    setNatural({ rows: 0, cols: 80 })
    expect(report.report(true)).toBe(false)
    expect(sent).toEqual([])
  })

  it("does not book a report the socket swallowed", () => {
    const { report, sent, setWire } = setup({ wire: false })
    expect(report.report(false)).toBe(false)
    setWire(true)
    expect(report.report(false)).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it("dedupes against a grid noted from a send while holding the size", () => {
    const { report, sent } = setup()
    report.note({ rows: 50, cols: 160 })
    expect(report.report(false)).toBe(false)
    expect(sent).toEqual([])
  })

  it("forgets what it sent when a new connection opens", () => {
    const { report, sent } = setup()
    report.report(false)
    report.reset()
    expect(report.report(false)).toBe(true)
    expect(sent).toHaveLength(2)
  })
})
