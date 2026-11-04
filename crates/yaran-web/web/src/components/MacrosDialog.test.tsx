// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"

import type { DragEndEvent, KeyboardSensorOptions } from "@dnd-kit/core"
import type { YaranState } from "@/lib/store"
import type { MacroView } from "@/lib/types"

// Reorder-by-drag contract, the FlatAgentList.test.tsx pattern: dnd-kit cannot
// run a real drag under jsdom (it measures rects), so DndContext is mocked to a
// passthrough that CAPTURES `onDragEnd` and the tests call it with synthetic
// DragEndEvents. useSortable is a static stub; what these tests pin is the
// dialog's own wiring: rows carry the sortable attributes, a drop reorders the
// draft, a persisted reorder goes through `persistMacroOrder`, and a refused
// save snaps the order back. Keyboard activation uses the real library gate
// against the row's registered activator, without pretending jsdom lays out a drag.
const dragEndHandlers: ((event: DragEndEvent) => void)[] = []
type TestSensor = { sensor: unknown; options: KeyboardSensorOptions }
let sensorDefinitions: TestSensor[] = []
const activatorNodes = new Map<string, HTMLElement | null>()
const sortableDisabled = new Map<string, boolean | undefined>()
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>()
  return {
    DndContext: ({
      children,
      onDragEnd,
      sensors,
    }: {
      children: React.ReactNode
      onDragEnd: (event: DragEndEvent) => void
      sensors: TestSensor[]
    }) => {
      dragEndHandlers.push(onDragEnd)
      sensorDefinitions = sensors
      return children
    },
    KeyboardSensor: actual.KeyboardSensor,
    MouseSensor: class {},
    TouchSensor: class {},
    closestCenter: () => {},
    useSensor: (sensor: unknown, options: KeyboardSensorOptions) => ({ sensor, options }),
    useSensors: (...sensors: unknown[]) => sensors,
  }
})
vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/sortable")>()
  return {
    SortableContext: ({ children }: { children: React.ReactNode }) => children,
    sortableKeyboardCoordinates: actual.sortableKeyboardCoordinates,
    verticalListSortingStrategy: {},
    useSortable: ({ id, disabled }: { id: string; disabled?: boolean }) => {
      sortableDisabled.set(id, disabled)
      return {
        attributes: { role: "button", "aria-roledescription": "sortable" },
        listeners: {},
        setNodeRef: () => {},
        setActivatorNodeRef: (node: HTMLElement | null) => { activatorNodes.set(id, node) },
        transform: null,
        transition: undefined,
        isDragging: false,
      }
    },
  }
})

const persistMacroOrderMock = vi.fn<(macros: MacroView[]) => Promise<boolean>>()
let mockState: YaranState
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>()
  return {
    ...actual,
    useYaran: () => mockState,
    closeMacrosDialog: vi.fn(),
    saveMacros: vi.fn(),
    persistMacroOrder: (macros: MacroView[]) => persistMacroOrderMock(macros),
  }
})

// The store touches localStorage/fetch at import time; stub the browser
// globals BEFORE the module graph evaluates.
function installStubs() {
  const mem = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  })
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("offline test"))),
  )
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  )
}
installStubs()
const { MacrosDialog } = await import("./MacrosDialog")

const seedMacros: MacroView[] = [
  { name: "Review", text: "review this", surface: "agent" },
  { name: "Build", text: "cargo build", surface: "terminal" },
  { name: "Deploy", text: "deploy it", surface: "both" },
]

function seed(macros: MacroView[], { bootstrap = true } = {}) {
  mockState = {
    macrosDialogOpen: true,
    macrosDraft: macros,
    bootstrap: bootstrap ? { macros } : null,
  } as unknown as YaranState
}

// The rendered macro names, in list DOM order.
function renderedNames(): string[] {
  return screen
    .getAllByRole("listitem")
    .map(
      (li) => li.querySelector("span.truncate")?.textContent ?? "(missing)",
    )
}

async function endDrag(activeId: string, overId: string | null) {
  const handler = dragEndHandlers.at(-1)
  expect(handler).toBeDefined()
  await act(async () => {
    handler!({
      active: { id: activeId },
      over: overId === null ? null : { id: overId },
    } as DragEndEvent)
  })
}

beforeEach(() => {
  installStubs()
  dragEndHandlers.length = 0
  sensorDefinitions = []
  activatorNodes.clear()
  sortableDisabled.clear()
  persistMacroOrderMock.mockReset()
  persistMacroOrderMock.mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("MacrosDialog reorder", () => {
  it("edits and reorders without mutating the store draft", async () => {
    const initial = seedMacros.map((macro) => Object.freeze({ ...macro }))
    Object.freeze(initial)
    seed(initial)
    render(<MacrosDialog />)

    fireEvent.click(screen.getByRole("button", { name: "Edit Review" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Review changes" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save macro" }))
    await endDrag("macro-0", "macro-2")

    expect(renderedNames()).toEqual(["Build", "Deploy", "Review changes"])
    expect(initial).toEqual(seedMacros)
  })

  it("renders the draft rows in order, each carrying the sortable attributes", () => {
    seed(seedMacros)
    render(<MacrosDialog />)
    expect(renderedNames()).toEqual(["Review", "Build", "Deploy"])
    // The drag activator (the row body, per the wrapper/activator split the
    // sidebar rows use) carries the sortable attributes; the listitem itself
    // keeps its list semantics.
    for (const li of screen.getAllByRole("listitem")) {
      expect(li.querySelector('[aria-roledescription="sortable"]')).toBeTruthy()
    }
  })

  it.each(["Space", "Enter"])("activates keyboard sorting with %s on the row, without intercepting Edit", async (code) => {
    const { KeyboardSensor } = await import("@dnd-kit/core")
    const { sortableKeyboardCoordinates } = await import("@dnd-kit/sortable")
    seed(seedMacros)
    render(<MacrosDialog />)

    const keyboard = sensorDefinitions.find(({ sensor }) => sensor === KeyboardSensor)
    expect(keyboard?.options.coordinateGetter).toBe(sortableKeyboardCoordinates)
    const row = screen.getAllByRole("listitem")[0]
    const activator = row.querySelector<HTMLElement>('[aria-roledescription="sortable"]')!
    const edit = screen.getByRole("button", { name: "Edit Review" })
    const context = {
      active: {
        id: "macro-0", key: "macro-0", node: { current: row },
        activatorNode: { current: activatorNodes.get("macro-0") ?? null },
        data: { current: {} },
      },
    }
    const handler = KeyboardSensor.activators[0].handler
    const preventDefault = vi.fn()
    const event = { nativeEvent: new KeyboardEvent("keydown", { code }), preventDefault }

    expect(handler({ ...event, target: activator }, keyboard!.options, context)).toBe(true)
    expect(handler({ ...event, target: edit }, keyboard!.options, context)).toBe(false)
    expect(preventDefault).toHaveBeenCalledOnce()
    fireEvent.click(edit)
    expect(screen.getByRole("textbox", { name: "Name" }).getAttribute("value")).toBe("Review")
    expect(persistMacroOrderMock).not.toHaveBeenCalled()
  })

  it("lets row arrows reach the document drag sensor while isolating nested controls", () => {
    seed(seedMacros)
    render(<MacrosDialog />)
    const row = screen.getAllByRole("listitem")[0]
    const activator = row.querySelector<HTMLElement>('[aria-roledescription="sortable"]')!
    const onKeyDown = vi.fn()
    document.addEventListener("keydown", onKeyDown)
    try {
      fireEvent.keyDown(activator, { key: "ArrowDown", code: "ArrowDown" })
      expect(onKeyDown).toHaveBeenCalledOnce()
      fireEvent.keyDown(screen.getByRole("button", { name: "Edit Review" }), {
        key: "ArrowDown", code: "ArrowDown",
      })
      expect(onKeyDown).toHaveBeenCalledOnce()
    } finally {
      document.removeEventListener("keydown", onKeyDown)
    }
  })

  it("shows friendly surface labels before opening the choices", () => {
    seed(seedMacros)
    render(<MacrosDialog />)
    for (const [name, label] of [["Review", "Agent"], ["Build", "Terminal"], ["Deploy", "Both"]]) {
      fireEvent.click(screen.getByRole("button", { name: `Edit ${name}` }))
      expect(within(screen.getByRole("combobox", { name: "Surface" })).getByText(label)).toBeTruthy()
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    }
    fireEvent.click(screen.getByRole("button", { name: "Add macro" }))
    expect(within(screen.getByRole("combobox", { name: "Surface" })).getByText("Agent")).toBeTruthy()
  })

  it("a drop moves the row and persists the reordered list wholesale", async () => {
    seed(seedMacros)
    render(<MacrosDialog />)

    await endDrag("macro-0", "macro-2")

    expect(renderedNames()).toEqual(["Build", "Deploy", "Review"])
    expect(persistMacroOrderMock).toHaveBeenCalledTimes(1)
    expect(
      persistMacroOrderMock.mock.calls[0][0].map((m) => m.name),
    ).toEqual(["Build", "Deploy", "Review"])
  })

  it("a refused save snaps the order back (optimistic apply, rollback on false)", async () => {
    persistMacroOrderMock.mockResolvedValue(false)
    seed(seedMacros)
    render(<MacrosDialog />)

    await endDrag("macro-0", "macro-2")

    // The store action already toasted; the dialog's job is the snap-back.
    expect(renderedNames()).toEqual(["Review", "Build", "Deploy"])
  })

  it("a no-op drop (same slot or no target) does not save", async () => {
    seed(seedMacros)
    render(<MacrosDialog />)

    await endDrag("macro-1", "macro-1")
    await endDrag("macro-1", null)

    expect(renderedNames()).toEqual(["Review", "Build", "Deploy"])
    expect(persistMacroOrderMock).not.toHaveBeenCalled()
  })

  it("an invalid draft reorders locally but defers persistence to Save", async () => {
    // Duplicate names: the wholesale PUT would be rejected server-side, so the
    // drag must keep the order in the draft (for the eventual Save) without
    // firing a doomed request.
    const dupes: MacroView[] = [
      { name: "Same", text: "a", surface: "agent" },
      { name: "Same", text: "b", surface: "agent" },
      { name: "Other", text: "c", surface: "both" },
    ]
    seed(dupes)
    render(<MacrosDialog />)

    await endDrag("macro-2", "macro-0")

    expect(renderedNames()).toEqual(["Other", "Same", "Same"])
    expect(persistMacroOrderMock).not.toHaveBeenCalled()
  })

  it("with bootstrap unloaded a drop reorders locally without saving", async () => {
    seed(seedMacros, { bootstrap: false })
    render(<MacrosDialog />)

    await endDrag("macro-2", "macro-0")

    expect(renderedNames()).toEqual(["Deploy", "Review", "Build"])
    expect(persistMacroOrderMock).not.toHaveBeenCalled()
  })
})


describe("macro save recovery", () => {
  it("keeps the edited list after failure and prevents dismissal during the write", async () => {
    const store = await import("@/lib/store")
    let finish!: (ok: boolean) => void
    vi.mocked(store.saveMacros).mockReturnValueOnce(new Promise<boolean>((resolve) => { finish = resolve }))
    vi.mocked(store.closeMacrosDialog).mockClear()
    seed([{ name: "Unsaved macro", text: "keep me", surface: "both" }])
    render(<MacrosDialog />)
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true)
    expect([...sortableDisabled.values()]).toEqual([true])
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    expect(store.closeMacrosDialog).not.toHaveBeenCalled()
    await act(async () => { finish(false) })
    expect([...sortableDisabled.values()]).toEqual([false])
    expect(screen.getByText("Unsaved macro")).toBeTruthy()
    expect(store.closeMacrosDialog).not.toHaveBeenCalled()
    vi.mocked(store.saveMacros).mockResolvedValueOnce(true)
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(store.closeMacrosDialog).toHaveBeenCalledOnce())
  })
})
