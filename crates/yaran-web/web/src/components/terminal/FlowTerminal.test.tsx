// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { FlowTerminal } from "./FlowTerminal"
import { trackFlowCursor } from "@/lib/terminalFlow"

const terms: Terminal[] = []
afterEach(() => { cleanup(); terms.splice(0).forEach((term) => term.dispose()); vi.restoreAllMocks() })
const write = (term: Terminal, text: string) => new Promise<void>((done) => term.write(text, done))
function mount() {
  const term = new Terminal({ cols: 120, rows: 24, allowProposedApi: true })
  terms.push(term)
  const focus = vi.fn()
  const interactions = { cursorVisible: trackFlowCursor(term).visible, tap: vi.fn(() => false), scroll: vi.fn() }
  const props = { termRef: { current: term }, interactionsRef: { current: interactions }, focusInput: focus, fontFamily: "monospace", fontSize: 16 }
  return { term, focus, interactions, props, ...render(<FlowTerminal {...props} />) }
}

it("reopens at the same readable font, wraps source text and follows live redraws without changing the decoder grid", async () => {
  const view = mount()
  await act(() => write(view.term, "reply ".repeat(19) + "\r\nPrompt: "))
  await screen.findByText(/reply reply/)
  const root = screen.getByTestId("flow-terminal")
  expect(root.style.fontSize).toBe("16px")
  expect(root.querySelector("[data-flow-row]")?.parentElement?.className).toContain("whitespace-pre-wrap")
  fireEvent.click(root)
  expect(view.focus).toHaveBeenCalledOnce()
  await act(() => write(view.term, "hello"))
  await screen.findByText("Prompt: hello")
  view.unmount()
  render(<FlowTerminal {...view.props} />)
  await screen.findByText("Prompt: hello")
  expect(screen.getByTestId("flow-terminal").style.fontSize).toBe("16px")
  expect([view.term.cols, view.term.rows]).toEqual([120, 24])
})

it("keeps a native text selection stable during output and resumes when selection clears", async () => {
  const view = mount()
  await act(() => write(view.term, "copy this"))
  const text = await screen.findByText("copy this")
  const range = document.createRange()
  range.selectNodeContents(text)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  await act(() => write(view.term, "\r\x1b[2Knew output"))
  await act(() => new Promise((done) => setTimeout(done, 80)))
  expect(selection.toString()).toBe("copy this")
  fireEvent.click(text)
  expect(view.focus).not.toHaveBeenCalled()
  selection.removeAllRanges()
  fireEvent(document, new Event("selectionchange"))
  await screen.findByText("new output")
})

it("maps a tap after a wide glyph back to its real terminal cell and keeps link activation from raising the keyboard", async () => {
  const view = mount()
  await act(() => write(view.term, "界URL"))
  const text = await screen.findByText("界URL")
  const caret = document.createRange()
  caret.setStart(text.firstChild!, 1)
  Object.defineProperty(document, "caretRangeFromPoint", { configurable: true, value: () => caret })
  view.interactions.tap.mockReturnValue(true)
  fireEvent.click(text)
  expect(view.interactions.tap).toHaveBeenCalledWith(0, 2)
  expect(view.focus).not.toHaveBeenCalled()
  delete (document as Partial<Document>).caretRangeFromPoint
})

it("scrolls wrapped output locally, forwarding only one wheel notch at the alternate screen's edge", async () => {
  const view = mount()
  await act(() => write(view.term, "normal output"))
  await screen.findByText("normal output")
  const root = screen.getByTestId("flow-terminal")
  fireEvent.wheel(root, { deltaY: 80 })
  expect(view.interactions.scroll).not.toHaveBeenCalled()
  await act(() => write(view.term, "\x1b[?1049halt screen"))
  await screen.findByText("alt screen")
  fireEvent.wheel(root, { deltaY: 80 })
  await waitFor(() => expect(view.interactions.scroll).toHaveBeenCalledWith(1))
})

it("uses theme colors for a visible cursor and removes it when the app hides it", async () => {
  const view = mount()
  await act(() => write(view.term, "prompt"))
  const caret = () => screen.getByTestId("flow-terminal").querySelector<HTMLElement>('span[style*="background-color: var(--foreground)"]')
  await waitFor(() => expect(caret()).not.toBeNull())
  expect(caret()!.style.color).toBe("var(--background)")
  await act(() => write(view.term, "\x1b[?25l"))
  await waitFor(() => expect(caret()).toBeNull())
  await act(() => write(view.term, "\x1b[?25h"))
  await waitFor(() => expect(caret()).not.toBeNull())
})

it("keeps real text that soft-wraps after a full source-grid decorative rule", async () => {
  const view = mount()
  await act(() => write(view.term, "─".repeat(120) + "Status: ready"))
  await screen.findByText("Status: ready")
  expect(screen.getByTestId("flow-terminal").querySelector("hr")).toBeNull()
})

it("maps both halves of a glyph to the same cell rather than the next caret boundary", async () => {
  const view = mount()
  await act(() => write(view.term, "abcd"))
  const text = await screen.findByText("abcd")
  const caret = document.createRange()
  caret.setStart(text.firstChild!, 2)
  const rects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects")
  Object.defineProperty(document, "caretRangeFromPoint", { configurable: true, value: () => caret })
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [{ left: 10, right: 20, top: 0, bottom: 20 }] })
  try {
    fireEvent.click(text, { clientX: 12.5, clientY: 10 })
    fireEvent.click(text, { clientX: 17.5, clientY: 10 })
    fireEvent.click(text, { clientX: 21, clientY: 10 })
    expect(view.interactions.tap.mock.calls).toEqual([[0, 1], [0, 1], [0, 2]])
  } finally {
    delete (document as Partial<Document>).caretRangeFromPoint
    if (rects) Object.defineProperty(Range.prototype, "getClientRects", rects)
    else delete (Range.prototype as Partial<Range>).getClientRects
  }
})
