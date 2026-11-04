import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { appMenuModel, findSubmenu, type AppMenuEntry } from "@/lib/appMenu"
import { useYaran } from "@/lib/store"

// The mobile app menu: the same `appMenuModel()` the desktop flyout renders,
// presented as a bottom sheet with drill-down, because a hover flyout cannot
// work on touch. Sharing the model and differing only in presentation is what
// keeps the two from drifting.
//
// The roles and aria-haspopup are supplied by hand here, since these rows are
// not base-ui primitives. `Sheet` still provides the dialog role, the focus
// trap, and Escape.

function AppMenuRows({
  entries,
  title,
  initialId,
  onBack,
  onDrill,
  onRun,
}: {
  entries: AppMenuEntry[]
  title: string
  initialId: string | null
  onBack?: () => void
  onDrill: (id: string) => void
  onRun: (run: () => void) => void
}) {
  const items = entries.filter((entry) => entry.kind !== "separator")
  const [initialFocusId] = useState(
    () => items.find((entry) => entry.id === initialId)?.id ?? items[0]?.id,
  )
  const [activeId, setActiveId] = useState(initialFocusId)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  // Each drill mounts a new list. Return to the row that opened it when Back
  // restores the root, rather than losing keyboard focus with the old list.
  useEffect(() => {
    if (initialFocusId) buttons.current.get(initialFocusId)?.focus()
  }, [initialFocusId])

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
    const index = items.findIndex((entry) => entry.id === id)
    let next: number
    if (event.key === "ArrowDown") next = (index + 1) % items.length
    else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = items.length - 1
    else if (event.key === "ArrowRight" && items[index]?.kind === "submenu") {
      event.preventDefault()
      onDrill(id)
      return
    } else if (event.key === "ArrowLeft" && onBack) {
      event.preventDefault()
      onBack()
      return
    } else if (event.key.length === 1 && event.key !== " ") {
      next = items.findIndex((_, offset) =>
        items[(index + 1 + offset) % items.length].title
          .toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()),
      )
      if (next < 0) return
      next = (index + 1 + next) % items.length
    } else return
    event.preventDefault()
    buttons.current.get(items[next].id)?.focus()
  }

  return (
    <div role="menu" aria-label={title} className="flex flex-col pb-2">
      {entries.map((entry) => {
        if (entry.kind === "separator") {
          return <div key={entry.id} role="separator" className="my-1 h-px bg-border" />
        }
        const Icon = entry.icon
        const isSubmenu = entry.kind === "submenu"
        return (
          <button
            key={entry.id}
            ref={(button) => {
              if (button) buttons.current.set(entry.id, button)
              else buttons.current.delete(entry.id)
            }}
            type="button"
            role="menuitem"
            tabIndex={activeId === entry.id ? 0 : -1}
            onFocus={() => setActiveId(entry.id)}
            onKeyDown={(event) => moveFocus(event, entry.id)}
            // min-h-11 is the 44px touch floor (CLAUDE.md touch-target tenet);
            // AppMenuSheet.test.tsx pins the class contract.
            className="flex min-h-11 w-full items-center gap-3 px-4 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none motion-reduce:transition-none"
            // A submenu row opens a deeper list rather than a popup, but it is
            // still a menuitem that owns a menu, so aria-haspopup is correct.
            // aria-expanded stays false: the child list REPLACES this one rather
            // than expanding under it, so nothing is expanded in place.
            aria-haspopup={isSubmenu ? "menu" : undefined}
            aria-expanded={isSubmenu ? false : undefined}
            onClick={() =>
              isSubmenu ? onDrill(entry.id) : onRun(entry.run)
            }
          >
            <Icon className="size-4 shrink-0" />
            <span className="flex-1">{entry.title}</span>
            {isSubmenu ? (
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

export function AppMenuSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [drilled, setDrilled] = useState<string | null>(null)
  const [returnId, setReturnId] = useState<string | null>(null)
  const sheetRef = useRef<HTMLDivElement>(null)

  // Reopening always starts at the root. Resetting only inside the close handler
  // would miss a close driven by the PARENT (it owns `open`), stranding the next
  // open three levels deep under a header that says "Menu". Keying off the
  // open->closed transition catches both. This is React's documented "adjust
  // state during render" pattern (a prev tracker compared each render, as
  // `NumberControl` in CustomizeWebappDialog.tsx already does) rather than an
  // effect, so the reset lands in the same commit as the prop change.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (!open) {
      setDrilled(null)
      setReturnId(null)
    }
  }

  // The model's one context input: gh availability gates the from-PR agent
  // variant, exactly as the launcher corner's ⋯ menu gates its copy.
  const { bootstrap } = useYaran()
  const ghAvailable = bootstrap?.gh_available ?? false
  const githubIntegrationEnabled = bootstrap?.github_integration ?? false

  const model = appMenuModel({ ghAvailable, githubIntegrationEnabled })
  const submenu = drilled ? findSubmenu(model, drilled) : null
  // Fall back to the root if a drilled id ever goes missing, so the sheet can
  // never strand the user on an empty list with no way back.
  const entries = submenu ? submenu.entries : model
  const title = submenu ? submenu.title : "Menu"

  function back() {
    // Keep focus on a surviving node during the swap, so the dialog's removed-
    // control recovery does not override the new list's focus handoff.
    sheetRef.current?.focus()
    setDrilled(null)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={sheetRef}
        side="bottom"
        initialFocus={() => sheetRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"][tabindex="0"]') ?? true}
        className="max-h-[80vh] overflow-y-auto"
      >
        <SheetHeader className="flex-row items-center gap-2 pb-0">
          {submenu ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Back"
              className="size-11 shrink-0"
              onClick={back}
            >
              <ChevronLeft />
            </Button>
          ) : null}
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription className="sr-only">
            yaran app menu: preferences, configuration, and agent-wide actions.
          </SheetDescription>
        </SheetHeader>
        <AppMenuRows
          key={submenu?.id ?? "root"}
          entries={entries}
          title={title}
          initialId={submenu ? null : returnId}
          onBack={submenu ? back : undefined}
          onDrill={(id) => {
            sheetRef.current?.focus()
            setReturnId(id)
            setDrilled(id)
          }}
          onRun={(run) => {
            run()
            onOpenChange(false)
          }}
        />
      </SheetContent>
    </Sheet>
  )
}
