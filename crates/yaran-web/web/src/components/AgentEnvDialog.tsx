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
import { envToText, parseEnv, validateEnv } from "@/lib/env"
import { closeAgentEnv, updateProjectSettings, useYaran } from "@/lib/store"
import type { ProjectView, SessionView } from "@/lib/types"
import { sessionLabel, workspaceProjectId } from "@/lib/agentWorkspace"

// Edit environment variables from an agent's menu. Env is project-scoped, so this
// edits the agent's PROJECT env, layered over the global env, and the copy says so.
// Mounted only while open and a project resolves; state seeds lazily from it.
function AgentEnvForm({
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
  const [text, setText] = useState(() => envToText(project.env))
  const envError = validateEnv(text)
  const agentName = sessionLabel(session)

  async function handleSave() {
    if (savingRef.current || envError) return
    const env = parseEnv(text)
    // No-op when unchanged (skips the request and just closes).
    const keys = Object.keys(env)
    const unchanged = keys.length === Object.keys(project.env).length
      && keys.every((key) => Object.hasOwn(project.env, key) && env[key] === project.env[key])
    const patch = unchanged ? {} : { env }
    savingRef.current = true
    setSaving(true)
    try {
      if (await updateProjectSettings(project.id, patch) && mounted.current) closeAgentEnv()
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <DialogContent showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>
          Environment: <InlineCode>{agentName}</InlineCode>
        </DialogTitle>
        <DialogDescription>
          KEY=VALUE per line, applied to every agent and terminal in project{" "}
          <InlineCode>{project.name}</InlineCode> (layered over the
          global env). This applies to the whole project, not just this agent.
        </DialogDescription>
      </DialogHeader>
      <Textarea
        aria-label="Project environment variables"
        aria-invalid={envError !== null}
        aria-describedby={envError ? "agent-env-error" : undefined}
        disabled={saving}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="KEY=VALUE"
        className="min-h-48 font-mono"
        autoFocus
      />
      {envError && <p id="agent-env-error" role="alert" className="text-sm text-destructive">{envError}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={saving} onClick={closeAgentEnv}>
          Cancel
        </Button>
        <Button onClick={() => void handleSave()} disabled={saving || envError !== null} aria-busy={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

export function AgentEnvDialog() {
  const savingRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const { spine, agentEnvTarget } = useYaran()
  const session = agentEnvTarget === null
    ? undefined
    : spine?.sessions.find((s) => s.id === agentEnvTarget)
  const projectId = session ? workspaceProjectId(session.workspace) : null
  const project = projectId === null
    ? undefined
    : spine?.projects.find((p) => p.id === projectId)
  // Closes the dialog when the agent or its project vanishes from the
  // ViewModel; see the hook.
  const open = useVanishedTargetGuard(
    agentEnvTarget !== null,
    session !== undefined && project !== undefined,
    closeAgentEnv,
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !savingRef.current) closeAgentEnv()
      }}
    >
      {open && session && project && (
        <AgentEnvForm key={session.id} session={session} project={project} saving={saving} setSaving={setSaving} savingRef={savingRef} />
      )}
    </Dialog>
  )
}
