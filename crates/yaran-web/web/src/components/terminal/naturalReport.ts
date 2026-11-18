// A page that does not hold the pty's size reports its NATURAL grid instead of
// fitting to it. The server records the report and applies it the moment this
// page types; nothing here touches the local grid, which stays the holder's.
export type Grid = { rows: number; cols: number }

export type NaturalReportDeps = {
  /// Whether a report may go out right now: not the holder, on screen and in
  /// the foreground. A report on a row nobody holds is applied, so a hidden
  /// page or a part off screen reporting would take the size for a viewport
  /// nobody sees.
  reports: () => boolean
  naturalGrid: () => Grid | null
  /// The socket's own answer to "did that frame go out".
  sendResize: (rows: number, cols: number) => boolean
}

export type NaturalReport = {
  /// Report the natural grid. `force` bypasses the dedupe. Answers whether a
  /// frame went out.
  report: (force: boolean) => boolean
  /// Record a grid this page told the server some other way (its own sends
  /// while it held the size), so the dedupe compares against it.
  note: (grid: Grid) => void
  /// A new connection: the server keeps no report across connections.
  reset: () => void
}

export function createNaturalReport(deps: NaturalReportDeps): NaturalReport {
  let last: Grid | null = null
  return {
    report(force) {
      if (!deps.reports()) return false
      const grid = deps.naturalGrid()
      if (!grid || grid.rows <= 0 || grid.cols <= 0) return false
      if (!force && last?.rows === grid.rows && last?.cols === grid.cols) {
        return false
      }
      if (!deps.sendResize(grid.rows, grid.cols)) return false
      last = grid
      return true
    },
    note(grid) {
      last = grid
    },
    reset() {
      last = null
    },
  }
}
