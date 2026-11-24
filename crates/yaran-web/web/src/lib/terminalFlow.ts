// Read the real terminal grid after parsing, then lay its text out independently.
// Cursor-addressed bytes must never be parsed at the phone's different width.
import type { CSSProperties } from "react"
import type { IBufferCell, Terminal } from "@xterm/xterm"

export type FlowRun = { text: string; style: CSSProperties; cursor: boolean }
export type FlowRow = { row: number; runs: FlowRun[]; wrapped: boolean; rule: boolean }
export type FlowScreen = { rows: FlowRow[]; earlier: boolean; alternate: boolean }

export function terminalFlowViewport(term: Pick<Terminal, "element">): HTMLElement | null {
  return term.element?.closest("[data-terminal-pane]")?.querySelector<HTMLElement>("[data-terminal-flow]") ?? null
}

export function scrollFlowToBottom(term: Pick<Terminal, "element">): void {
  const viewport = terminalFlowViewport(term)
  if (!viewport) return
  const selection = viewport.ownerDocument.getSelection()
  if (selection && viewport.contains(selection.anchorNode)) selection.removeAllRanges()
  viewport.scrollTop = viewport.scrollHeight
}

// xterm exposes cursor coordinates but not DECTCEM visibility through its buffer API.
export function trackFlowCursor(term: Terminal) {
  let visible = true
  const mode = (show: boolean) => (params: (number | number[])[]) => {
    if (params.includes(25)) visible = show
    return false
  }
  const reset = () => { visible = true; return false }
  const subscriptions = [
    term.parser.registerCsiHandler({ prefix: "?", final: "h" }, mode(true)),
    term.parser.registerCsiHandler({ prefix: "?", final: "l" }, mode(false)),
    term.parser.registerCsiHandler({ intermediates: "!", final: "p" }, reset),
    term.parser.registerEscHandler({ final: "c" }, reset),
  ]
  return { visible: () => visible, dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) }
}

// These are xterm's protocol palette defaults, not application theme colours.
const ANSI = ["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf", "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"]

function palette(index: number): string {
  if (index < 16) return ANSI[index]
  if (index >= 232) return `rgb(${Array(3).fill(8 + (index - 232) * 10).join(",")})`
  const cube = index - 16
  const channel = (n: number) => n === 0 ? 0 : 55 + n * 40
  return `rgb(${channel(Math.floor(cube / 36))},${channel(Math.floor(cube / 6) % 6)},${channel(cube % 6)})`
}

function cellStyle(cell: IBufferCell): CSSProperties {
  const rgb = (n: number) => `#${n.toString(16).padStart(6, "0")}`
  let color = cell.isFgRGB() ? rgb(cell.getFgColor()) : cell.isFgPalette() ? palette(cell.getFgColor()) : undefined
  let backgroundColor = cell.isBgRGB() ? rgb(cell.getBgColor()) : cell.isBgPalette() ? palette(cell.getBgColor()) : undefined
  if (cell.isInverse()) [color, backgroundColor] = [backgroundColor ?? "var(--background)", color ?? "var(--foreground)"]
  return {
    color,
    backgroundColor,
    fontWeight: cell.isBold() ? "bold" : undefined,
    fontStyle: cell.isItalic() ? "italic" : undefined,
    opacity: cell.isDim() ? 0.5 : undefined,
    textDecoration: [cell.isUnderline() ? "underline" : "", cell.isStrikethrough() ? "line-through" : ""].filter(Boolean).join(" ") || undefined,
  }
}

export function terminalFlowScreen(term: Terminal, historyRows = 200, cursorVisible = true): FlowScreen {
  // shortcut: render recent history first; Earlier output expands up to the configured scrollback.
  const buffer = term.buffer.active
  const start = Math.max(0, buffer.baseY - historyRows)
  const cursorRow = buffer.baseY + buffer.cursorY
  const rows: FlowRow[] = []
  for (let y = start; y < buffer.length; y++) {
    const line = buffer.getLine(y)
    if (!line) continue
    const text = line.translateToString(!buffer.getLine(y + 1)?.isWrapped)
    const rule = y !== cursorRow && /^[\s─━═╌┄┈]{4,}$/.test(text) && /[─━═╌┄┈]/.test(text)
    const runs: FlowRun[] = []
    let lastKey = ""
    let position = 0
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x)
      if (!cell || cell.getWidth() === 0) continue
      const cursorCol = Math.min(buffer.cursorX, term.cols - 1)
      const cursor = cursorVisible && y === cursorRow && x <= cursorCol && cursorCol < x + cell.getWidth()
      const chars = cell.getChars() || " "
      if (position >= text.length && !cursor && (y !== cursorRow || x > buffer.cursorX)) break
      const style = cellStyle(cell)
      const key = JSON.stringify([style, cursor])
      const visible = cell.isInvisible() ? " ".repeat(cell.getWidth()) : chars
      if (key === lastKey) runs[runs.length - 1].text += visible
      else runs.push({ text: visible, style, cursor })
      lastKey = key
      position += chars.length
    }
    rows.push({ row: y, runs, wrapped: line.isWrapped, rule })
  }
  // Keep intentional blank lines inside the output; empty screen padding is not output.
  while (rows.length > 1 && rows[rows.length - 1].row > cursorRow && rows[rows.length - 1].runs.length === 0) rows.pop()
  return { rows, earlier: start > 0, alternate: buffer.type === "alternate" }
}

// A DOM text offset is UTF-16; terminal columns count wide glyphs as two cells.
export function flowColumn(term: Terminal, row: number, offset: number): number {
  const line = term.buffer.active.getLine(row)
  if (!line) return 0
  let textOffset = 0
  for (let col = 0; col < line.length; col++) {
    const cell = line.getCell(col)
    if (!cell || cell.getWidth() === 0) continue
    const next = textOffset + (cell.isInvisible() ? cell.getWidth() : (cell.getChars() || " ").length)
    if (offset < next) return col
    textOffset = next
  }
  return Math.max(0, term.cols - 1)
}
