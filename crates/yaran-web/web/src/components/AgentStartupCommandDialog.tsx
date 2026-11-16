import { useEffect, useRef, useState } from "react"

import { Button } from "@yaran/ui-kit/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@yaran/ui-kit/dialog"
import { InlineCode } from "@yaran/ui-kit/inline-code"
import { Textarea } from "@/components/ui/textarea"
import { useVanishedTargetGuard } from "@/hooks/use-vanished-target"
import {
  closeAgentStartupCommand,
  updateProjectSettings,
  useYaran,
} from "@/lib/store"
import type { ProjectView, SessionView } from "@/lib/types"
import { sessionLabel, workspaceProjectId } from "@/lib/agentWorkspace"

// Edit the startup command from an agent's menu. It is project-scoped, so this
// edits the agent's PROJECT and the copy says so. The form is mounted only while
// open and a project resolves; its state seeds lazily from the project.
function AgentStartupCommandForm({
  session,
  project,
  saving,
  setSaving,
  savingRef,
}: {
  session: SessionView
  project: ProjectView
  saving: boolean
  setSaving: (value: boolean) => void
  savingRef: React.RefObject<boolean>
}) {
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const [startup, setStartup] = useState(() => project.startup_command ?? "")
  const agentName = sessionLabel(session)

  async function handleSave() {
    if (savingRef.current) return
    const next = startup.trim() === "" ? null : startup
    // No-op when unchanged; `updateProjectSettings` skips the request on an empty
    // patch, so saving without a change just closes.
    const patch =
      next === (project.startup_command ?? null) ? {} : { startup_command: next }
    savingRef.current = true
    setSaving(true)
    try {
      if (await updateProjectSettings(project.id, patch) && mounted.current) closeAgentStartupCommand()
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <DialogContent showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>
          Startup command: <InlineCode>{agentName}</InlineCode>
        </DialogTitle>
        <DialogDescription>
          Runs after each agent or terminal launches in project{" "}
          <InlineCode>{project.name}</InlineCode>. This applies to
          every agent in the project, not just this one. Leave empty to clear it.
        </DialogDescription>
      </DialogHeader>
      <Textarea
        aria-label="Startup command"
        disabled={saving}
        value={startup}
        onChange={(e) => setStartup(e.target.value)}
        onKeyDown={(e) => {
          // Plain Enter inserts a newline (a startup command can be multi-line);
          // Cmd/Ctrl-Enter saves, matching the common textarea submit convention.
          if (
            e.key === "Enter" &&
            (e.metaKey || e.ctrlKey) &&
            !e.nativeEvent.isComposing &&
            e.keyCode !== 229
          ) {
            e.preventDefault()
            void handleSave()
          }
        }}
        placeholder="npm run dev"
        className="min-h-16 font-mono"
        autoFocus
      />
      <DialogFooter>
        <Button variant="outline" disabled={saving} onClick={closeAgentStartupCommand}>
          Cancel
        </Button>
        <Button onClick={() => void handleSave()} disabled={saving} aria-busy={saving}>{saving ? "Saving…" : "Save"}</Button>
      </DialogFooter>
    </DialogContent>
  )
}

export function AgentStartupCommandDialog() {
  const savingRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const { spine, agentStartupCommandTarget } = useYaran()
  const session = agentStartupCommandTarget === null
    ? undefined
    : spine?.sessions.find((s) => s.id === agentStartupCommandTarget)
  // A standalone agent belongs to no project, so the lookup must not happen at
  // all for one rather than miss.
  const projectId = session ? workspaceProjectId(session.workspace) : null
  const project = projectId === null
    ? undefined
    : spine?.projects.find((p) => p.id === projectId)
  // Closes the dialog when the agent or its project vanishes from the
  // ViewModel; see the hook.
  const open = useVanishedTargetGuard(
    agentStartupCommandTarget !== null,
    session !== undefined && project !== undefined,
    closeAgentStartupCommand,
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !savingRef.current) closeAgentStartupCommand()
      }}
    >
      {open && session && project && (
        <AgentStartupCommandForm key={session.id} session={session} project={project} saving={saving} setSaving={setSaving} savingRef={savingRef} />
      )}
    </Dialog>
  )
}
