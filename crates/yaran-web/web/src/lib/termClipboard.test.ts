import { beforeEach, describe, expect, it, vi } from "vitest"

// The raiser is mocked rather than sonner, because what this file is about is
// what the clipboard path ASKS FOR: a notification carrying no id.
vi.mock("./notify", () => ({
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
}))

const { notifyError, notifySuccess } = await import("./notify")

const copyToClipboard = vi.fn(async (_text: string) => true)
vi.mock("./clipboard", () => ({
  copyToClipboard: (text: string) => copyToClipboard(text),
}))

const { copyTermSelection, pasteIntoTerm } = await import("./termClipboard")

function fakeTerm(selection: string) {
  return {
    getSelection: () => selection,
    paste: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  copyToClipboard.mockImplementation(async () => true)
})

describe("copying the terminal selection", () => {
  // A fixed toast id is a REPLACEMENT instruction: sonner resets a toast's
  // remaining time only when its DURATION changes while re-running the close
  // timer on every re-raise, so re-raising the same message on one id restarts
  // the countdown without ever letting it finish. Copy-on-select fires on every
  // drag, so a shared id pins "Copied to clipboard" open for as long as the
  // copying goes on. Each copy is its own event, so each one retires on its own
  // clock.
  it("raises every copy as its own notification, sharing no id and so no clock", async () => {
    const term = fakeTerm("hello")
    for (let i = 0; i < 3; i++) await copyTermSelection(term, () => {})

    expect(notifySuccess).toHaveBeenCalledTimes(3)
    for (const call of vi.mocked(notifySuccess).mock.calls) {
      expect(call[0]).toBe("Copied to clipboard")
      expect(call[1]?.id).toBeUndefined()
    }
  })

  // A refused copy carries an id only so its own button can replace it, and a
  // fresh one each time, so two refusals never share a clock either.
  it("reports each failed copy on an id of its own", async () => {
    copyToClipboard.mockImplementation(async () => false)
    const term = fakeTerm("hello")
    await copyTermSelection(term, () => {})
    await copyTermSelection(term, () => {})

    expect(notifyError).toHaveBeenCalledTimes(2)
    const [first, second] = vi.mocked(notifyError).mock.calls
    expect(first[1]?.id).toBeTruthy()
    expect(first[1]?.id).not.toBe(second[1]?.id)
    expect(notifySuccess).not.toHaveBeenCalled()
  })

  // The browser refuses a copy with no user activation behind it, which is
  // what a phone's long-press drag ends as; a tap on the button is one.
  it("offers a Copy button that copies the same text and replaces its toast", async () => {
    copyToClipboard.mockImplementation(async () => false)
    await copyTermSelection(fakeTerm("selected text"), () => {})
    const [, opts] = vi.mocked(notifyError).mock.calls[0]
    expect(opts?.action?.label).toBe("Copy")

    copyToClipboard.mockImplementation(async () => true)
    opts?.action?.onClick()
    await vi.waitFor(() => expect(notifySuccess).toHaveBeenCalled())
    expect(copyToClipboard).toHaveBeenLastCalledWith("selected text")
    expect(vi.mocked(notifySuccess).mock.calls[0][1]?.id).toBe(opts?.id)
  })

  it("says nothing at all when there is no selection", async () => {
    await copyTermSelection(fakeTerm(""), () => {})
    expect(copyToClipboard).not.toHaveBeenCalled()
    expect(notifySuccess).not.toHaveBeenCalled()
    expect(notifyError).not.toHaveBeenCalled()
  })

  it("restores focus after the copy settles, whether it worked or not", async () => {
    const refocus = vi.fn()
    await copyTermSelection(fakeTerm("hello"), refocus)
    expect(refocus).toHaveBeenCalledTimes(1)

    copyToClipboard.mockImplementation(async () => false)
    await copyTermSelection(fakeTerm("hello"), refocus)
    expect(refocus).toHaveBeenCalledTimes(2)
  })
})

describe("pasting into the terminal", () => {
  it("raises every unreadable-clipboard hint as its own notification", async () => {
    // `readText` missing entirely is the plain-HTTP / Firefox-web-content case,
    // and it THROWS synchronously rather than rejecting, which is why the call
    // is guarded rather than merely caught.
    vi.stubGlobal("navigator", {})
    const term = fakeTerm("")
    await pasteIntoTerm(term, () => {})
    await pasteIntoTerm(term, () => {})

    expect(notifyError).toHaveBeenCalledTimes(2)
    for (const call of vi.mocked(notifyError).mock.calls) {
      expect(call[1]?.id).toBeUndefined()
    }
    vi.unstubAllGlobals()
  })

  it("pastes what it read and says nothing on success", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { readText: async () => "from the clipboard" },
    })
    const term = fakeTerm("")
    await pasteIntoTerm(term, () => {})

    expect(term.paste).toHaveBeenCalledWith("from the clipboard")
    expect(notifyError).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("reports a rejected read, with no id either", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        readText: async () => {
          throw new Error("denied")
        },
      },
    })
    const term = fakeTerm("")
    await pasteIntoTerm(term, () => {})

    expect(notifyError).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyError).mock.calls[0][1]?.id).toBeUndefined()
    vi.unstubAllGlobals()
  })
})
