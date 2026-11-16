import { useRef, useState } from "react"
import type { CSSProperties } from "react"
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import type { DragEndEvent } from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { ListPlus, Pencil, Trash2 } from "lucide-react"

import { SimpleTooltip } from "@/components/SimpleTooltip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@yaran/ui-kit/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@yaran/ui-kit/dialog"
import { Input } from "@yaran/ui-kit/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@yaran/ui-kit/select"
import { Textarea } from "@/components/ui/textarea"
import {
  MOUSE_DRAG_ACTIVATION,
  TOUCH_DRAG_ACTIVATION,
} from "@/lib/dragActivation"
import {
  MACRO_SURFACE_OPTIONS,
  commitMacro,
  isMacroSurface,
  macroDragIds,
  macroTextPreview,
  reorderMacrosByDrag,
  validateMacros,
} from "@/lib/macros"
import {
  closeMacrosDialog,
  persistMacroOrder,
  saveMacros,
  useYaran,
} from "@/lib/store"
import type { MacroSurface, MacroView } from "@/lib/types"
import { cn } from "@yaran/ui-kit/cn"

// The dialog's two internal modes: the LIST (rows + Add) or the per-row EDIT/ADD
// form. `editing` is the draft index being edited, "new" while adding, or null
// while on the list.
type EditorMode = { kind: "list" } | { kind: "form"; index: number | "new" }

const SURFACE_LABEL: Record<MacroSurface, string> = {
  agent: "Agent",
  terminal: "Terminal",
  both: "Both",
}

// The form mounts only while open. Edits replace arrays and entries, so the
// store's seeded draft needs no second clone; Save writes the whole list.
function MacrosEditor({ initial, saving, setSaving, savingRef }: {
  initial: MacroView[]
  saving: boolean
  setSaving: (value: boolean) => void
  savingRef: React.RefObject<boolean>
}) {
  // The bootstrap document holds the authoritative macro list. Until it loads,
  // the draft was seeded empty, so a wholesale save would wipe the server's
  // macros: disable Save in that window (the store also refuses it defensively).
  const { bootstrap } = useYaran()
  const [macros, setMacros] = useState(initial)
  const [mode, setMode] = useState<EditorMode>({ kind: "list" })
  // The draft index pending delete confirmation, or null. Inline confirm row
  // (the dialog's established confirm style) rather than a nested modal.
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null)

  // Reorder by drag, the agents-pane idiom: a mouse drags on a short pull so a
  // click on the row's buttons stays a click, and a touch drags on a hold so the
  // gesture coexists with the list's scroll. Values live in lib/dragActivation.ts.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: MOUSE_DRAG_ACTIVATION }),
    useSensor(TouchSensor, { activationConstraint: TOUCH_DRAG_ACTIVATION }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function handleDragEnd(event: DragEndEvent) {
    if (savingRef.current) return
    const { active, over } = event
    if (!over) return
    const prev = macros
    const next = reorderMacrosByDrag(prev, String(active.id), String(over.id))
    if (next === prev) return
    // Rows are about to shift index; a pending delete-confirm would point at
    // the wrong row afterwards, so retire it with the drop.
    setDeleteIndex(null)
    // Optimistic apply, then persist through the same wholesale save the Save
    // button uses. When the draft cannot be saved yet, the order stays in the
    // draft and the eventual Save carries it.
    setMacros(next)
    if (bootstrap === null || validateMacros(next) !== null) return
    savingRef.current = true
    setSaving(true)
    void persistMacroOrder(next)
      .then((ok) => {
        if (!ok) setMacros((current) => (current === next ? prev : current))
      })
      .finally(() => {
        savingRef.current = false
        setSaving(false)
      })
  }

  if (mode.kind === "form") {
    return (
      <MacroForm
        macro={mode.index === "new" ? null : macros[mode.index]}
        onCancel={() => setMode({ kind: "list" })}
        onCommit={(macro) => {
          setMacros((prev) => commitMacro(prev, mode.index, macro))
          setMode({ kind: "list" })
        }}
      />
    )
  }

  const validationError = validateMacros(macros)
  async function save() {
    if (savingRef.current || validationError || bootstrap === null) return
    savingRef.current = true
    setSaving(true)
    try {
      if (await saveMacros(macros)) closeMacrosDialog()
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <DialogContent
      showCloseButton={false}
      className="flex flex-col sm:max-w-lg"
      onKeyDown={(event) => {
        // dnd-kit listens on document; let focused row keys pass the dialog's
        // composite-key boundary while keeping nested controls isolated.
        if (
          event.target instanceof HTMLElement &&
          event.target.getAttribute("aria-roledescription") === "sortable"
        ) event.preventBaseUIHandler()
      }}
    >
      <DialogHeader className="shrink-0">
        <DialogTitle>Edit macros</DialogTitle>
        <DialogDescription>
          Text macros you can send to an agent or a terminal from the macro
          button on the terminal pane.
        </DialogDescription>
      </DialogHeader>

      <fieldset disabled={saving} className="contents">
      {macros.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No macros yet. Add one to get started.
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={macroDragIds(macros)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="flex min-h-0 max-h-72 flex-col gap-1 overflow-y-auto">
              {macros.map((macro, index) => (
                <SortableMacroRow
                  key={index}
                  macro={macro}
                  index={index}
                  disabled={saving}
                  deleteOpen={deleteIndex === index}
                  onEdit={() => {
                    setDeleteIndex(null)
                    setMode({ kind: "form", index })
                  }}
                  onAskDelete={() => setDeleteIndex(index)}
                  onCancelDelete={() => setDeleteIndex(null)}
                  onConfirmDelete={() => {
                    setMacros((prev) => prev.filter((_, i) => i !== index))
                    setDeleteIndex(null)
                  }}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <Button
        variant="outline"
        size="sm"
        className="w-full shrink-0"
        onClick={() => {
          setDeleteIndex(null)
          setMode({ kind: "form", index: "new" })
        }}
      >
        <ListPlus />
        Add macro
      </Button>
      </fieldset>

      {validationError ? (
        <p className="shrink-0 text-xs text-destructive">{validationError}</p>
      ) : null}

      {/* Misclick-safe spacing between the list/add controls and the footer. */}
      <div className="h-1 shrink-0" />
      <DialogFooter className="shrink-0">
        <Button variant="outline" disabled={saving} onClick={closeMacrosDialog}>
          Cancel
        </Button>
        <Button
          onClick={() => void save()}
          disabled={saving || validationError !== null || bootstrap === null}
          aria-busy={saving}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

// One draggable macro row, whole-row like the agents-pane rows: `useSortable`
// supplies the drag props with no separate handle, the sensors' activation gates
// are what keep the row's own buttons working, and the wrapper carries the
// Y-locked transform so the row cannot slide out of the dialog column.
function SortableMacroRow({
  macro,
  index,
  disabled,
  deleteOpen,
  onEdit,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  macro: MacroView
  index: number
  disabled: boolean
  deleteOpen: boolean
  onEdit: () => void
  onAskDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: `macro-${index}`, disabled })
  const style: CSSProperties = {
    // Vertical reorder list: lock the drag to the Y axis (see AgentFlatRow).
    transform: transform
      ? `translate3d(0, ${Math.round(transform.y)}px, 0)`
      : undefined,
    transition,
    opacity: isDragging ? 0.6 : undefined,
  }

  return (
    // The row lifts while dragging, so a touch hold that armed the drag reads as
    // grabbed before the finger moves. The `li` carries the ref, transform and
    // lift and keeps its list semantics, while the drag props go on the row body,
    // because dnd-kit's attributes set a button role that belongs on the
    // activator. The delete-confirm strip stays outside the activator so its
    // buttons are never contended by a drag.
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border bg-background p-2.5",
        isDragging && "z-10 shadow-lg",
      )}
    >
      <div
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        className="flex touch-manipulation flex-col gap-1.5"
      >
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{macro.name}</span>
          <Badge variant="secondary" className="shrink-0">
            {SURFACE_LABEL[macro.surface] ?? macro.surface}
          </Badge>
          <div className="ml-auto flex gap-1">
            <SimpleTooltip content="Edit">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Edit ${macro.name}`}
                onClick={onEdit}
              >
                <Pencil />
              </Button>
            </SimpleTooltip>
            <SimpleTooltip content="Delete">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${macro.name}`}
                onClick={onAskDelete}
              >
                <Trash2 />
              </Button>
            </SimpleTooltip>
          </div>
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {macroTextPreview(macro.text)}
        </p>
      </div>
      {deleteOpen ? (
        <div className="flex items-center gap-2 border-t pt-2">
          <span className="text-xs text-destructive">Delete this macro?</span>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" autoFocus onClick={onCancelDelete}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={onConfirmDelete}>
              Delete
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

// The add/edit form for a single macro. Local draft state seeded from the macro
// being edited (or blank for a new one) via lazy initializers; commits the row
// back to the list, which owns the wholesale set.
function MacroForm({
  macro,
  onCancel,
  onCommit,
}: {
  macro: MacroView | null
  onCancel: () => void
  onCommit: (macro: MacroView) => void
}) {
  const [name, setName] = useState(() => macro?.name ?? "")
  const [text, setText] = useState(() => macro?.text ?? "")
  const [surface, setSurface] = useState<MacroSurface>(
    () => macro?.surface ?? "agent",
  )

  const canSave = name.trim() !== "" && text !== ""

  function handleCommit() {
    if (!canSave) return
    onCommit({ name: name.trim(), text, surface })
  }

  return (
    <DialogContent showCloseButton={false} className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{macro ? "Edit macro" : "Add macro"}</DialogTitle>
      </DialogHeader>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="macro-name" className="text-sm font-medium text-muted-foreground">
            Name
          </label>
          <Input
            id="macro-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Review"
            autoFocus
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="macro-text" className="text-sm font-medium text-muted-foreground">
            Text
          </label>
          <Textarea
            id="macro-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="review this code for bugs"
            rows={6}
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Newlines are sent as Alt+Enter, so the whole macro is one prompt.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="macro-surface" className="text-sm font-medium text-muted-foreground">
            Surface
          </label>
          <Select
            value={surface}
            onValueChange={(v) => {
              if (typeof v === "string" && isMacroSurface(v)) setSurface(v)
            }}
          >
            <SelectTrigger id="macro-surface" className="w-full">
              <SelectValue>{SURFACE_LABEL[surface]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {MACRO_SURFACE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <div className="flex flex-col">
                    <span>{option.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Misclick-safe spacing between the fields and the footer. */}
      <div className="h-1" />
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={handleCommit} disabled={!canSave}>
          {macro ? "Save macro" : "Add macro"}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

export function MacrosDialog() {
  const { macrosDialogOpen, macrosDraft } = useYaran()
  const savingRef = useRef(false)
  const [saving, setSaving] = useState(false)

  return (
    <Dialog
      open={macrosDialogOpen}
      onOpenChange={(o) => {
        if (!o && !savingRef.current) closeMacrosDialog()
      }}
    >
      {macrosDialogOpen && <MacrosEditor initial={macrosDraft} saving={saving} setSaving={setSaving} savingRef={savingRef} />}
    </Dialog>
  )
}
