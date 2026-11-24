// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { afterEach, expect, it } from "vitest"
import { flowColumn, terminalFlowScreen } from "./terminalFlow"

const terminals: Terminal[] = []
function terminal(cols = 120, rows = 24) {
  const term = new Terminal({ cols, rows, allowProposedApi: true })
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = "11"
  terminals.push(term)
  return term
}
const write = (term: Terminal, text: string) => new Promise<void>((done) => term.write(text, done))
const texts = (term: Terminal) => terminalFlowScreen(term).rows.map((row) => row.runs.map((run) => run.text).join(""))
afterEach(() => { terminals.splice(0).forEach((term) => term.dispose()) })

it("decodes desktop cursor redraws at the source grid without resizing or appending stale text", async () => {
  const term = terminal()
  await write(term, "Old reply\r\n" + "x".repeat(110) + "\r\nPrompt: ")
  await write(term, "\x1b[1;1H\x1b[2KNew reply\x1b[3;9Hhello")
  expect(texts(term)).toEqual(["New reply", "x".repeat(110), "Prompt: hello "])
  expect([term.cols, term.rows]).toEqual([120, 24])
  expect(terminalFlowScreen(term).rows[2].runs.at(-1)?.cursor).toBe(true)
})

it("marks soft wraps for joining, preserving explicit newlines and removing empty screen padding", async () => {
  const term = terminal(8, 6)
  await write(term, "12345678continued\r\nnext")
  const rows = terminalFlowScreen(term).rows
  expect(rows.map((row) => row.wrapped)).toEqual([false, true, true, false])
  expect(texts(term).join("")).toBe("12345678continuednext ")
})

it("maps UTF-16 taps to the source cells, including combining marks, emoji and wide glyphs", async () => {
  const term = terminal()
  await write(term, "a界✅e\u0301Z")
  expect(texts(term)[0]).toBe("a界✅e\u0301Z ")
  expect([0, 1, 2, 3, 4, 5, 6].map((offset) => flowColumn(term, 0, offset))).toEqual([0, 1, 3, 5, 5, 6, 7])
  await write(term, "\x1b[1;3H")
  expect(terminalFlowScreen(term).rows[0].runs.find((run) => run.cursor)?.text).toBe("界")
})

it("preserves terminal styling without exposing invisible text", async () => {
  const term = terminal()
  await write(term, "\x1b[1;3;4;38;2;1;2;3mStyled\x1b[0m \x1b[8msecret\x1b[0m!")
  const run = terminalFlowScreen(term).rows[0].runs[0]
  expect(run.style).toMatchObject({ color: "#010203", fontWeight: "bold", fontStyle: "italic", textDecoration: "underline" })
  expect(texts(term)[0]).toBe("Styled       ! ")
})

it("keeps real text and offers older scrollback while fitting decorative rules locally", async () => {
  const term = terminal(10, 3)
  await write(term, "older\r\n" + "─".repeat(10) + "\r\n----\r\ncurrent")
  const recent = terminalFlowScreen(term, 0)
  expect(recent.earlier).toBe(true)
  expect(recent.rows.map((row) => row.rule)).toEqual([true, false, false])
  expect(terminalFlowScreen(term, 200).rows[0].runs[0].text).toBe("older")
})
