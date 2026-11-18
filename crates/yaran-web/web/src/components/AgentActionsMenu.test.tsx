// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import type { YaranState } from "@/lib/store"
import type { SessionView } from "@/lib/types"
import { stubCoarsePointer, type MatchMediaStub } from "@/test/matchMedia"

// The agent ⋯ menu: the gating of each entry, its shape (leading icon, the
// trailing ellipsis on an entry that opens a dialog) and where it routes.
let mockState: YaranState
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>()
  return {
    ...actual,
    useYaran: () => mockState,
    openPullRequests: vi.fn(),
    openStopAgent: vi.fn(),
    openRecreateWorkingCopy: vi.fn(),
  }
})

// The store touches localStorage at import time (pulled in transitively), so
// stub the browser globals BEFORE the module graph evaluates.
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
  // AgentActionsMenu calls useIsMobile() (the bar quick toggles are
  // mobile-scoped), whose subscription needs matchMedia; jsdom has none.
  // Same inert stub TerminalPane.test.tsx installs. matches:false = desktop,
  // which is what these desktop-menu tests want.
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
const { AgentActionsMenu } = await import("./AgentActionsMenu")
const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } = await import(
  "@yaran/ui-kit/dropdown-menu"
)
const store = await import("@/lib/store")
const openPullRequests = vi.mocked(store.openPullRequests)
const openStopAgent = vi.mocked(store.openStopAgent)
const openRecreateWorkingCopy = vi.mocked(store.openRecreateWorkingCopy)

function makeSession(over: Partial<SessionView> & { id: string }): SessionView {
  return {
    workspace: {
      kind: "managed",
      project_id: "p1",
      branch_name: over.id,
      initial_branch: over.id,
      branch_provenance: "created",
      source_branch: "main",
      worktree_path: `/tmp/${over.id}`,
    },
    title: over.id,
    provider: "claude",
    status: "active",
    auto_reopen_enabled: false,
    tabs: [],
    has_output: false,
    working: false,
    typing: false,
    needs_attention: false,
    slot_tab_id: over.id,
    created_at: "2026-07-17T12:00:00Z",
    updated_at: "2026-07-17T12:00:00Z",
    ...over,
  } as SessionView
}

function seed(session: SessionView, ghAvailable: boolean) {
  mockState = {
    bootstrap: {
      gh_available: ghAvailable,
      available_providers: ["claude"],
      agent_tabs_max: 20,
    },
    spine: { projects: [], sessions: [session] },
    createTabInFlight: [],
  } as unknown as YaranState
}

function openMenu(session: SessionView) {
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <AgentActionsMenu session={session} />
      </DropdownMenuContent>
    </DropdownMenu>,
  )
  fireEvent.click(screen.getByText("open"))
  return screen.findByRole("menu")
}

const prAuto = {
  number: 12,
  state: "open" as const,
  title: "Add a thing",
  url: "https://github.com/o/r/pull/12",
  overridden: false,
}
const prPinned = {
  ...prAuto,
  overridden: true,
  attached: true,
  host: "github.com",
  owner_repo: "o/r",
}

beforeEach(() => {
  installStubs()
  openPullRequests.mockClear()
  openStopAgent.mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("AgentActionsMenu while another device holds the terminal's size", () => {
  // Every device types into a shared terminal, so another device having typed
  // last disables nothing here. A change that would end somebody else's
  // terminal is refused by the server, naming who, not greyed out in the menu.
  const labels = [
    "New agent tab…",
    "Force recreate agent…",
    "Enable agent auto-reopen",
    "Rename agent…",
    "Change agent provider…",
    "Delete agent…",
  ]

  it("keeps every entry enabled and shows no hint", async () => {
    const session = makeSession({
      id: "s1",
      pr: prPinned,
      tabs: [
        { id: "s1", provider: "claude", order: 0, input_owner: "42" },
      ] as unknown as SessionView["tabs"],
    })
    seed(session, true)
    await openMenu(session)
    for (const label of labels) {
      const item = screen.getByText(label).closest('[role="menuitem"]')
      expect(item?.getAttribute("aria-disabled"), label).not.toBe("true")
    }
    expect(screen.queryByText(/active on another device/i)).toBeNull()
  })
})

describe("AgentActionsMenu contents and tab availability", () => {
  const desktopWidth = window.innerWidth
  let media: MatchMediaStub | null = null

  afterEach(() => {
    media?.restore()
    media = null
    Object.defineProperty(window, "innerWidth", {
      value: desktopWidth,
      configurable: true,
    })
  })

  it("carries no view toggles, changed-file row or input group", async () => {
    // All of them belong to `PaneMenu`, which renders this body as its agent
    // group and adds them once, around it. This menu is the AGENT's actions
    // wherever it is opened from, and a row menu carrying the terminal
    // screen's chrome toggles was how it stopped being that.
    const session = makeSession({ id: "s1" })
    seed(session, true)
    Object.defineProperty(window, "innerWidth", {
      value: 500,
      configurable: true,
    })
    media = stubCoarsePointer()

    await openMenu(session)
    expect(screen.queryByText("Hide terminal keys")).toBeNull()
    expect(screen.queryByText(/^Changes/)).toBeNull()
    // The INPUT group's label, which the wrapper prints and this body must
    // not: one group per menu, and this is not the menu.
    expect(screen.queryByText("Input")).toBeNull()
  })

  it("keeps the new-tab submenu disabled at the configured tab cap", async () => {
    const session = makeSession({
      id: "s1",
      tabs: [
        { id: "s1", provider: "claude", order: 0 },
      ] as unknown as SessionView["tabs"],
    })
    seed(session, true)
    ;(
      mockState.bootstrap as NonNullable<YaranState["bootstrap"]>
    ).agent_tabs_max = 1

    await openMenu(session)
    const trigger = screen
      .getByText("New agent tab…")
      .closest('[role="menuitem"]')
    expect(trigger?.getAttribute("aria-disabled")).toBe("true")
    expect(
      screen
        .getByText("Rename agent…")
        .closest('[role="menuitem"]')
        ?.getAttribute("aria-disabled"),
    ).not.toBe("true")
  })
})

function makeStandaloneSession(id: string): SessionView {
  return {
    ...makeSession({ id }),
    workspace: {
      kind: "folder",
      folder_path: `/home/someone/${id}`,
      folder_label: `~/${id}`,
      repo_status: "no_repo",
      quiet_reason: "This folder has no git repository.",
    },
  }
}

describe("AgentActionsMenu for a standalone agent", () => {
  // ABSENT, not disabled. A disabled row is a promise that the thing exists and
  // is unavailable right now; these features do not exist for this kind of
  // agent at all, and never will, so there is nothing for a user to wait for.
  it("offers no branch-identity entries at all", async () => {
    const session = makeStandaloneSession("sa1")
    seed(session, true)
    await openMenu(session)
    for (const absent of [
      /Fork agent/,
      /Pull requests/,
      /Configure startup command/,
      /Rerun startup command/,
    ]) {
      expect(screen.queryByText(absent)).toBeNull()
    }
  })

  // The features that never needed git keep working: the agent still runs, is
  // still renamed, still retargets its provider, and still gets deleted.
  it("keeps every entry that was never about a branch", async () => {
    const session = makeStandaloneSession("sa1")
    seed(session, true)
    await openMenu(session)
    for (const present of [
      "Rename agent…",
      "Change agent provider…",
      "Agent info…",
      "New terminal in the folder",
    ]) {
      expect(screen.getByText(present)).toBeTruthy()
    }
  })
})

// A group that is absent for one kind of agent must take its separator with
// it, or the menu draws two rules with nothing between them.
describe("AgentActionsMenu separators", () => {
  function rows(): string[] {
    return Array.from(
      document.querySelectorAll('[role="menuitem"], [role="separator"]'),
    ).map((el) => el.getAttribute("role") ?? "")
  }

  for (const [kind, build] of [
    ["a managed agent", () => makeSession({ id: "s1" })],
    ["a standalone agent", () => makeStandaloneSession("sa1")],
  ] as const) {
    it(`never puts two separators together, nor one at either end, for ${kind}`, async () => {
      const session = build()
      seed(session, true)
      await openMenu(session)
      const seen = rows()
      expect(seen.length).toBeGreaterThan(0)
      expect(seen[0]).not.toBe("separator")
      expect(seen.at(-1)).not.toBe("separator")
      for (let i = 1; i < seen.length; i += 1) {
        expect(
          seen[i] === "separator" && seen[i - 1] === "separator",
          `separators at ${i - 1} and ${i}`,
        ).toBe(false)
      }
    })
  }
})

describe("AgentActionsMenu terminal entry names where the shell opens", () => {
  it("says the worktree for a managed agent and the folder for a standalone one", async () => {
    seed(makeSession({ id: "s1" }), false)
    await openMenu(makeSession({ id: "s1" }))
    expect(screen.getByText("New terminal in the worktree")).toBeTruthy()
    // A standalone agent has no worktree at all, so promising one here would
    // be a label about something that does not exist.
    expect(screen.queryByText(/New terminal in the folder/)).toBeNull()
    cleanup()

    const standalone = makeStandaloneSession("sa1")
    seed(standalone, false)
    await openMenu(standalone)
    expect(screen.getByText("New terminal in the folder")).toBeTruthy()
    expect(screen.queryByText(/worktree/)).toBeNull()
  })

  // The label is longer than the one it replaced, and this menu is the phone's
  // too (the pane flap and the mobile row both render it). Nothing between the
  // text and the menu item may clip it: the popup caps its own width and lets
  // an item wrap, so a stray truncate/nowrap class is what would hide the half
  // of the label that carries the location.
  it("lets the label wrap rather than clipping it on a narrow screen", async () => {
    const session = makeSession({ id: "s1" })
    seed(session, false)
    await openMenu(session)
    const text = screen.getByText("New terminal in the worktree")
    const item = text.closest('[role="menuitem"]')
    expect(item).toBeTruthy()
    for (
      let node: Element | null = text;
      node && node !== item?.parentElement;
      node = node.parentElement
    ) {
      expect(node.className).not.toMatch(
        /truncate|text-ellipsis|whitespace-nowrap|line-clamp/,
      )
    }
  })
})

describe("AgentActionsMenu pull-request entry", () => {
  // One entry for everything about pull requests, with or without gh: the
  // dialog behind it says when attaching needs a signed-in gh, and hiding or
  // detaching never talks to GitHub, so a pull request never outlives the way
  // to remove it.
  it("offers Pull requests… with or without gh, with icon and trailing ellipsis, routed to the store", async () => {
    for (const gh of [true, false]) {
      const session = makeSession({ id: "s1", pr: prPinned })
      seed(session, gh)
      await openMenu(session)
      const item = screen.getByText("Pull requests…").closest('[role="menuitem"]')
      expect(item).toBeTruthy()
      expect(item!.querySelector("svg")).toBeTruthy()
      expect(screen.queryByText(/Attach pull request/)).toBeNull()
      expect(screen.queryByText(/Detach pull request/)).toBeNull()
      fireEvent.click(screen.getByText("Pull requests…"))
      expect(openPullRequests).toHaveBeenLastCalledWith("s1")
      cleanup()
    }
  })
})

// Detaching asks the agent's processes to shut down and leaves the agent in the
// list. What is pinned here is the GATING (a live process, over every tab, not
// the first alone), the shape (leading icon, trailing ellipsis, neutral colour)
// and that it only ever opens the confirmation.
describe("AgentActionsMenu detach entry", () => {
  function liveTab(id: string) {
    return {
      id,
      provider: "claude",
      order: 0,
      has_live_process: true,
    } as unknown as SessionView["tabs"][number]
  }

  function dormantTab(id: string) {
    return {
      id,
      provider: "claude",
      order: 0,
      has_live_process: false,
    } as unknown as SessionView["tabs"][number]
  }

  it("is absent, not disabled, when nothing is running", async () => {
    const session = makeSession({ id: "s1", tabs: [dormantTab("s1")] })
    seed(session, true)
    await openMenu(session)
    expect(screen.queryByText("Detach agent…")).toBeNull()
  })

  it("appears when any tab is running, not only the first", async () => {
    const session = makeSession({
      id: "s1",
      tabs: [dormantTab("s1"), liveTab("b2")],
    })
    seed(session, true)
    await openMenu(session)
    expect(screen.getByText("Detach agent…")).toBeTruthy()
  })

  it("carries an icon, a trailing ellipsis, and no destructive colour", async () => {
    const session = makeSession({ id: "s1", tabs: [liveTab("s1")] })
    seed(session, true)
    await openMenu(session)
    const item = screen.getByText("Detach agent…").closest('[role="menuitem"]')
    expect(item).toBeTruthy()
    expect(item!.querySelector("svg")).toBeTruthy()
    expect(item!.textContent?.endsWith("…")).toBe(true)
    // The ellipsis and the dialog are the danger signal; only Delete is red.
    expect(item!.getAttribute("data-variant")).not.toBe("destructive")
  })

  it("opens the confirmation and never acts on the click itself", async () => {
    const session = makeSession({ id: "s1", tabs: [liveTab("s1")] })
    seed(session, true)
    await openMenu(session)
    fireEvent.click(screen.getByText("Detach agent…"))
    expect(openStopAgent).toHaveBeenCalledWith("s1")
  })

})

// The way out of a working copy the agent deleted from under itself. The gating
// is the point: the entry exists ONLY in that state, because it is the way out
// of it, and never for a standalone agent, whose folder is the user's.
describe("AgentActionsMenu recreate-working-copy entry", () => {
  beforeEach(() => {
    openRecreateWorkingCopy.mockClear()
  })
  afterEach(cleanup)

  function missingCopy(id: string): SessionView {
    const session = makeSession({ id })
    return {
      ...session,
      workspace: {
        ...session.workspace,
        worktree_missing: true,
        worktree_label: `~/worktrees/${id}`,
        quiet_reason: "The working copy no longer exists on disk.",
      },
    } as SessionView
  }

  it("is absent while the working copy is there", async () => {
    const session = makeSession({ id: "s1" })
    seed(session, true)
    await openMenu(session)
    expect(screen.queryByText("Recreate working copy…")).toBeNull()
  })

  it("appears once the working copy is gone", async () => {
    const session = missingCopy("s1")
    seed(session, true)
    await openMenu(session)
    expect(screen.getByText("Recreate working copy…")).toBeTruthy()
  })

  it("carries an icon, a trailing ellipsis, and no destructive colour", async () => {
    const session = missingCopy("s1")
    seed(session, true)
    await openMenu(session)
    const item = screen
      .getByText("Recreate working copy…")
      .closest('[role="menuitem"]')
    expect(item).toBeTruthy()
    expect(item!.querySelector("svg")).toBeTruthy()
    expect(item!.textContent?.endsWith("…")).toBe(true)
    // The ellipsis and the dialog are the danger signal; only Delete is red.
    expect(item!.getAttribute("data-variant")).not.toBe("destructive")
  })

  it("opens the dialog and never acts on the click", async () => {
    const session = missingCopy("s1")
    seed(session, true)
    await openMenu(session)
    fireEvent.click(screen.getByText("Recreate working copy…"))
    expect(openRecreateWorkingCopy).toHaveBeenCalledWith("s1")
  })

  // yaran never creates, moves or removes a standalone agent's folder, so there
  // is no recreate to offer however gone that folder is.
  it("is absent for a standalone agent", async () => {
    const base = makeSession({ id: "sa1" })
    const session = {
      ...base,
      workspace: {
        kind: "folder",
        folder_path: "/home/someone/notes",
        folder_label: "~/notes",
        repo_status: "missing",
        quiet_reason: "The folder no longer exists on disk.",
      },
    } as SessionView
    seed(session, true)
    await openMenu(session)
    expect(screen.queryByText("Recreate working copy…")).toBeNull()
  })
})
