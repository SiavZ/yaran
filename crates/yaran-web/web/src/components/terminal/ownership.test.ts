// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"

import { notifyPtyOwner, resetPtyOwnerEpochs } from "@/lib/ptyOwnership"

import { useTerminalOwnership } from "./ownership"

/// `document.visibilityState`, which is what `isForeground` reads.
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  })
}

function setup() {
  const view = renderHook(() => useTerminalOwnership({ id: "p1" }))
  return { view }
}

beforeEach(() => {
  resetPtyOwnerEpochs()
  setVisibility("visible")
})
afterEach(() => {
  setVisibility("visible")
})

describe("the initial verdict", () => {
  it("guesses it holds the size when the document is foregrounded", () => {
    const { view } = setup()
    expect(view.result.current.isOwner).toBe(true)
    expect(view.result.current.ownership.read()).toBe(true)
  })

  it("guesses it does not while the document is hidden", () => {
    setVisibility("hidden")
    const { view } = setup()
    expect(view.result.current.isOwner).toBe(false)
  })
})

// Typing moves the size to the typist, and the server says so with a
// `pty.owner` event. Losing the size costs nothing but the local grid: every
// page keeps typing, so nothing here is sticky.
describe("a handover", () => {
  it("renders the holder's grid once another page holds the size", () => {
    const { view } = setup()
    act(() => view.result.current.connId.write("mine"))
    act(() => notifyPtyOwner("p1", "theirs", 1))
    expect(view.result.current.isOwner).toBe(false)
    // The channel flips synchronously, ahead of the re-render, so the
    // coordinator's next fit already knows.
    expect(view.result.current.ownership.read()).toBe(false)
  })

  it("takes the size back the moment the server names this page again", () => {
    const { view } = setup()
    act(() => view.result.current.connId.write("mine"))
    act(() => notifyPtyOwner("p1", "theirs", 1))
    act(() => notifyPtyOwner("p1", "mine", 2))
    expect(view.result.current.isOwner).toBe(true)
    expect(view.result.current.rowConfirmed).toBe(true)
    expect(view.result.current.readRowConfirmed()).toBe(true)
  })

  it("reads a NULL id as 'not us', so a pre-connected handover is safe", () => {
    const { view } = setup()
    act(() => notifyPtyOwner("p1", "theirs", 1))
    expect(view.result.current.isOwner).toBe(false)
  })

  it("ignores a handover for another pty entirely", () => {
    const { view } = setup()
    act(() => notifyPtyOwner("other", "theirs", 1))
    expect(view.result.current.isOwner).toBe(true)
  })
})

// The handshake decides, and the foreground guess survives only for a row
// nobody holds.
describe("seeding the verdict from the connected handshake", () => {
  it("renders the holder's grid when another page holds the size", () => {
    const { view } = setup()
    act(() => view.result.current.seedFromConnected("mine", "theirs"))
    expect(view.result.current.isOwner).toBe(false)
    expect(view.result.current.rowConfirmed).toBe(false)
  })

  it("keeps a foregrounded pane the holder of a row nobody holds", () => {
    const { view } = setup()
    act(() => view.result.current.seedFromConnected("mine", null))
    expect(view.result.current.isOwner).toBe(true)
    // A guess, not the server's word: a pane off screen must not act on it.
    expect(view.result.current.rowConfirmed).toBe(false)
  })

  it("leaves a BACKGROUNDED pane rendering the pty's grid on a row nobody holds", () => {
    setVisibility("hidden")
    const { view } = setup()
    act(() => view.result.current.seedFromConnected("mine", null))
    expect(view.result.current.isOwner).toBe(false)
  })

  it("confirms the row when the handshake names this page", () => {
    const { view } = setup()
    act(() => view.result.current.seedFromConnected("mine", "mine"))
    expect(view.result.current.isOwner).toBe(true)
    expect(view.result.current.rowConfirmed).toBe(true)
  })

  it("falls back to the foreground guess against a server that omits the owner", () => {
    const { view } = setup()
    act(() => view.result.current.seedFromConnected("mine", undefined))
    expect(view.result.current.isOwner).toBe(true)
    expect(view.result.current.rowConfirmed).toBe(true)
  })

  // THE CROSS-SOCKET RACE: the handshake and `pty.owner` ride different
  // sockets, and a stale null snapshot must not undo a newer handover.
  it("keeps a newer handover over a stale null handshake", () => {
    const { view } = setup()
    act(() => view.result.current.connId.write("mine"))
    act(() => notifyPtyOwner("p1", "theirs", 1))
    act(() => view.result.current.seedFromConnected("mine", null, 0))
    expect(view.result.current.isOwner).toBe(false)
  })

  it("seeds normally from a handshake at or after the applied epoch", () => {
    const { view } = setup()
    act(() => view.result.current.connId.write("mine"))
    act(() => notifyPtyOwner("p1", "theirs", 1))
    act(() => view.result.current.seedFromConnected("mine2", null, 2))
    expect(view.result.current.isOwner).toBe(true)
  })

  // The page's other pane took the size on the driver id this socket is seated
  // on, and that event beat this pane's own, older handshake.
  it("holds the size when a newer event already named this seat", () => {
    const { view } = setup()
    act(() => notifyPtyOwner("p1", "seat", 5))
    expect(view.result.current.isOwner).toBe(false)
    act(() => view.result.current.seedFromConnected("seat", "other", 4))
    expect(view.result.current.isOwner).toBe(true)
    expect(view.result.current.rowConfirmed).toBe(true)
  })

  it("forgets the confirmation when the connection changes", () => {
    const { view } = setup()
    // The socket's own order: the id is written, then the handshake seeds.
    act(() => view.result.current.connId.write("mine"))
    act(() => view.result.current.seedFromConnected("mine", "mine"))
    expect(view.result.current.readRowConfirmed()).toBe(true)
    act(() => view.result.current.connId.write(null))
    expect(view.result.current.readRowConfirmed()).toBe(false)
  })
})

describe("the LOST state", () => {
  it("is raised by a socket that gave up and cleared by any reopen", () => {
    const { view } = setup()
    act(() => view.result.current.notePtyConn("failed"))
    expect(view.result.current.connectionLost).toBe(true)
    act(() => view.result.current.notePtyConn("connecting"))
    expect(view.result.current.connectionLost).toBe(false)
  })
})
