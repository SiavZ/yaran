// A PTY has one authoritative grid, the size holder's (the page that typed
// last). A page that does not hold it renders at that grid, so this keeps the
// grid the wire last reported, and the pane's own, for the relayout.
//
// There is no reconnect here: the faithful path re-grids xterm on every `size`
// event before the child's repaint for it arrives, so a grid change leaves no
// polluted scrollback to heal. A bounce would only drop the keystrokes of the
// page that just lost the size, often while it is still typing.
import { useMemo, useState } from "react"

export type Grid = { rows: number; cols: number }

export type ViewerGrid = {
  /// The PTY's grid as the wire last reported it, or null when nothing has.
  remoteGrid: Grid | null
  /// This xterm's own grid, or null before the first fit.
  localGrid: Grid | null
  /// Record a grid the wire reported, null when the server could not say.
  noteRemoteGrid: (grid: Grid | null, fromHandshake: boolean) => void
  /// Record this xterm's grid. Called for the mount fit and from xterm's own
  /// resize event, which fires only when the grid really changed.
  noteLocalGrid: (grid: Grid) => void
}

const keepIfSame = (prev: Grid | null, grid: Grid): Grid =>
  prev && prev.rows === grid.rows && prev.cols === grid.cols ? prev : grid

export function useViewerGrid(): ViewerGrid {
  const [remoteGrid, setRemoteGrid] = useState<Grid | null>(null)
  const [localGrid, setLocalGrid] = useState<Grid | null>(null)
  // Stable identities: the lifecycle closes over these callbacks once.
  const notes = useMemo(
    () => ({
      noteRemoteGrid(grid: Grid | null) {
        setRemoteGrid(grid)
      },
      noteLocalGrid(grid: Grid) {
        setLocalGrid((prev) => keepIfSame(prev, grid))
      },
    }),
    [],
  )
  return { ...notes, remoteGrid, localGrid }
}
