// The phone renders text from a correctly decoded terminal, at its own width.
// Its native text selection and scrolling never change the shared PTY's grid.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import type { Terminal } from "@xterm/xterm"
import { Button } from "@yaran/ui-kit/button"
import { clampTerminalFontSize, terminalFontFamily } from "@/lib/terminalFont"
import { flowColumn, terminalFlowScreen, type FlowRow, type FlowScreen } from "@/lib/terminalFlow"

export type FlowInteractions = {
  cursorVisible?: () => boolean
  tap: (row: number, col: number) => boolean
  scroll: (lines: number) => void
}

type Props = {
  termRef: RefObject<Terminal | null>
  interactionsRef: RefObject<FlowInteractions | null>
  focusInput: () => void
  fontFamily: string
  fontSize: number
}

function pointOffset(event: React.MouseEvent, element: HTMLElement): number | null {
  const doc = element.ownerDocument
  const caret = doc.caretPositionFromPoint?.(event.clientX, event.clientY)
  const range = caret ? doc.createRange() : doc.caretRangeFromPoint?.(event.clientX, event.clientY)
  if (caret && range) range.setStart(caret.offsetNode, caret.offset)
  if (!range || !element.contains(range.startContainer)) return null
  const prefix = doc.createRange()
  prefix.selectNodeContents(element)
  prefix.setEnd(range.startContainer, range.startOffset)
  const text = prefix.toString()
  // Caret hit-testing rounds to the nearest boundary. A tap on a glyph's right
  // half still belongs to that glyph, including wide and combining sequences.
  const previous = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].at(-1)
  if (previous) {
    const glyph = prefix.cloneRange()
    const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let offset = previous.index
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0
      if (offset < length) {
        glyph.setStart(node, offset)
        break
      }
      offset -= length
    }
    if ([...(glyph.getClientRects?.() ?? [])].some((rect) =>
      event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom,
    )) return previous.index
  }
  return text.length
}

function logicalRows(rows: FlowRow[]): FlowRow[][] {
  const groups: FlowRow[][] = []
  for (const row of rows) {
    if (row.wrapped && groups.length > 0) groups[groups.length - 1].push(row)
    else groups.push([row])
  }
  return groups
}

export function FlowTerminal({ termRef, interactionsRef, focusInput, fontFamily, fontSize }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [screen, setScreen] = useState<FlowScreen>({ rows: [], earlier: false, alternate: false })
  const [historyRows, setHistoryRows] = useState(200)
  const following = useRef(true)
  const historyAnchor = useRef<number | null>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let stop: (() => void) | undefined
    let disposed = false
    const update = () => {
      timer = undefined
      const term = termRef.current
      const root = rootRef.current
      if (!term || !root || disposed) return
      const selection = root.ownerDocument.getSelection()
      if (selection && !selection.isCollapsed && root.contains(selection.anchorNode)) return
      if (historyAnchor.current === null) following.current = root.scrollHeight - root.scrollTop - root.clientHeight < 24
      setScreen(terminalFlowScreen(term, historyRows, interactionsRef.current?.cursorVisible?.() ?? true))
    }
    const schedule = () => {
      if (timer === undefined) timer = setTimeout(update, 50)
    }
    // The parent's lifecycle opens the terminal in its passive effect, after
    // this child's effect. Read once the same commit's effects have finished.
    const mount = setTimeout(() => {
      if (disposed) return
      const term = termRef.current
      if (!term) return
      const parsed = term.onWriteParsed(schedule)
      const resized = term.onResize(schedule)
      term.textarea?.setAttribute("aria-label", "Terminal input")
      stop = () => { parsed.dispose(); resized.dispose() }
      update()
    }, 0)
    document.addEventListener("selectionchange", schedule)
    return () => {
      disposed = true
      clearTimeout(mount)
      clearTimeout(timer)
      stop?.()
      document.removeEventListener("selectionchange", schedule)
    }
  }, [termRef, interactionsRef, historyRows])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (historyAnchor.current !== null) {
      root.scrollTop += root.scrollHeight - historyAnchor.current
      historyAnchor.current = null
    } else if (following.current) root.scrollTop = root.scrollHeight
  }, [screen])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let touchY = 0
    let remainder = 0
    const atEdge = (delta: number) => screen.alternate && (
      delta < 0 ? root.scrollTop <= 0 : root.scrollTop + root.clientHeight >= root.scrollHeight - 1
    )
    const wheel = (event: WheelEvent) => {
      if (!atEdge(event.deltaY)) return
      event.preventDefault()
      interactionsRef.current?.scroll(event.deltaY < 0 ? -1 : 1)
    }
    const start = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? 0
      remainder = 0
    }
    const move = (event: TouchEvent) => {
      if (event.touches.length !== 1) return
      const y = event.touches[0].clientY
      const delta = touchY - y
      touchY = y
      if (!atEdge(delta)) return
      event.preventDefault()
      remainder += delta / (clampTerminalFontSize(fontSize) * 1.5)
      const lines = Math.trunc(remainder)
      if (lines !== 0) {
        interactionsRef.current?.scroll(Math.sign(lines))
        remainder -= lines
      }
    }
    root.addEventListener("wheel", wheel, { passive: false })
    root.addEventListener("touchstart", start, { passive: true })
    root.addEventListener("touchmove", move, { passive: false })
    return () => {
      root.removeEventListener("wheel", wheel)
      root.removeEventListener("touchstart", start)
      root.removeEventListener("touchmove", move)
    }
  }, [screen.alternate, interactionsRef, fontSize])

  const tap = (event: React.MouseEvent) => {
    const selection = document.getSelection()
    if (selection && !selection.isCollapsed) return
    const row = (event.target as Element).closest<HTMLElement>("[data-flow-row]")
    const term = termRef.current
    if (row && term) {
      const offset = pointOffset(event, row)
      if (offset !== null && interactionsRef.current?.tap(Number(row.dataset.flowRow), flowColumn(term, Number(row.dataset.flowRow), offset))) return
    }
    focusInput()
  }

  return (
    <div
      ref={rootRef}
      data-testid="flow-terminal"
      data-terminal-flow=""
      className="absolute inset-0 overflow-y-auto overflow-x-hidden bg-background p-2 text-foreground select-text"
      style={{ fontFamily: terminalFontFamily(fontFamily), fontSize: clampTerminalFontSize(fontSize), lineHeight: 1.5, WebkitUserSelect: "text", touchAction: "pan-y pinch-zoom" }}
      onScroll={() => {
        const root = rootRef.current!
        following.current = root.scrollHeight - root.scrollTop - root.clientHeight < 24
      }}
      onClick={tap}
    >
      {screen.earlier ? <Button variant="ghost" size="sm" onClick={(event) => {
        event.stopPropagation()
        following.current = false
        const root = rootRef.current!
        historyAnchor.current = root.scrollHeight
        setHistoryRows((count) => count + 200)
      }}>Earlier output</Button> : null}
      <div role="log" aria-label="Terminal output">
        {logicalRows(screen.rows).map((rows) => rows.length === 1 && rows[0].rule ? (
          <hr key={rows[0].row} className="my-1 border-border" />
        ) : (
          <div key={rows[0].row} className="min-h-[1.5em] whitespace-pre-wrap [overflow-wrap:anywhere]">
            {rows.map((row) => <span key={row.row} data-flow-row={row.row}>{row.runs.map((run, index) => (
              <span key={index} style={run.cursor ? { ...run.style, color: "var(--background)", backgroundColor: "var(--foreground)" } : run.style}>{run.text}</span>
            ))}</span>)}
          </div>
        ))}
      </div>
      <button type="button" className="sr-only focus:not-sr-only" onClick={(event) => { event.stopPropagation(); focusInput() }}>Type in terminal</button>
    </div>
  )
}
