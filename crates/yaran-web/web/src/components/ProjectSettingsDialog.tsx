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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@yaran/ui-kit/select"
import { Textarea } from "@/components/ui/textarea"
import { useVanishedTargetGuard } from "@/hooks/use-vanished-target"
import { envToText, parseEnv, validateEnv } from "@/lib/env"
import { closeProjectSettings, updateProjectSettings, useYaran } from "@/lib/store"
import type { PatchProjectBody } from "@/lib/projectsApi"
import type { ProjectView } from "@/lib/types"

// The form body is mounted only while the dialog is open and a project resolves.
// Each local state seeds from the project prop via a lazy initializer so there
// is no set-state-in-effect to seed the controls on open.
function ProjectSettingsForm({
  project,
  providers,
  saving,
  setSaving,
  savingRef,
}: {
  project: ProjectView
  providers: string[]
  saving: boolean
  setSaving: (value: boolean) => void
  savingRef: React.RefObject<boolean>
}) {
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  // "" means "inherit the global default provider".
  const [provider, setProvider] = useState<string>(
    () => project.explicit_default_provider ?? "",
  )
  const [autoReopen, setAutoReopen] = useState<string>(() =>
    project.auto_reopen_agents === null
      ? "inherit"
      : project.auto_reopen_agents
        ? "on"
        : "off",
  )
  const [startup, setStartup] = useState(() => project.startup_command ?? "")
  const [envText, setEnvText] = useState(() => envToText(project.env))
  const envError = validateEnv(envText)

  async function handleSave() {
    if (savingRef.current || envError) return
    // Build one tri-state PATCH body: include only the fields that changed (the
    // server leaves an omitted field untouched), with `null` clearing a scalar
    // back to the inherited default. `updateProjectSettings` no-ops on an empty
    // patch, so saving with nothing changed sends no request.
    const patch: PatchProjectBody = {}

    const newProvider = provider === "" ? null : provider
    if (newProvider !== (project.explicit_default_provider ?? null)) {
      patch.provider = newProvider
    }

    const newAutoReopen =
      autoReopen === "inherit" ? null : autoReopen === "on" ? true : false
    if (newAutoReopen !== (project.auto_reopen_agents ?? null)) {
      patch.auto_reopen_agents = newAutoReopen
    }

    const newStartup = startup.trim() === "" ? null : startup
    if (newStartup !== (project.startup_command ?? null)) {
      patch.startup_command = newStartup
    }

    const env = parseEnv(envText)
    const keys = Object.keys(env)
    const unchanged = keys.length === Object.keys(project.env).length
      && keys.every((key) => Object.hasOwn(project.env, key) && env[key] === project.env[key])
    if (!unchanged) {
      patch.env = env
    }

    // Close only once the PATCH succeeds. The PATCH is not atomic across its
    // independent fields, so on a rejection we keep the dialog open (the error is
    // toasted) rather than dismissing it over a partially-applied change.
    savingRef.current = true
    setSaving(true)
    try {
      if (await updateProjectSettings(project.id, patch) && mounted.current) closeProjectSettings()
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <DialogContent showCloseButton={false} className="flex flex-col sm:max-w-lg">
      <DialogHeader className="shrink-0">
        <DialogTitle>
          Project settings: <InlineCode>{project.name}</InlineCode>
        </DialogTitle>
        <DialogDescription>
          Per-project overrides. Leave a field on the inherited default to fall
          back to the global configuration.
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 overflow-y-auto">
        <fieldset disabled={saving} className="grid min-w-0 gap-4">
          <div className="grid gap-2">
            <label htmlFor="project-default-provider" className="text-sm font-medium">Default provider</label>
            <Select
              value={provider}
              onValueChange={(value) => setProvider(value ?? "")}
            >
              <SelectTrigger id="project-default-provider" className="w-full max-md:min-h-11">
                <SelectValue>{provider || "Inherit global default"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Inherit global default</SelectItem>
                {providers.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <label htmlFor="project-auto-reopen" className="text-sm font-medium">Auto-reopen agents</label>
            <Select
              value={autoReopen}
              onValueChange={(value) => setAutoReopen(value ?? "inherit")}
            >
              <SelectTrigger id="project-auto-reopen" className="w-full max-md:min-h-11">
                <SelectValue>{autoReopen === "inherit" ? "Inherit global default" : autoReopen === "on" ? "On" : "Off"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">Inherit global default</SelectItem>
                <SelectItem value="on">On</SelectItem>
                <SelectItem value="off">Off</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <label htmlFor="project-startup-command" className="text-sm font-medium">Startup command</label>
            <Textarea
              id="project-startup-command"
              value={startup}
              onChange={(e) => setStartup(e.target.value)}
              placeholder="npm run dev"
              className="min-h-16 font-mono"
            />
          </div>

          <div className="grid gap-2">
            <label htmlFor="project-environment" className="text-sm font-medium">Environment</label>
            <Textarea
              id="project-environment"
              aria-invalid={envError !== null}
              aria-describedby={envError ? "project-env-error" : undefined}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder="KEY=VALUE"
              className="min-h-32 font-mono"
            />
            {envError && <p id="project-env-error" role="alert" className="text-sm text-destructive">{envError}</p>}
          </div>
        </fieldset>
      </div>

      <DialogFooter className="shrink-0">
        <Button variant="outline" disabled={saving} onClick={closeProjectSettings}>
          Cancel
        </Button>
        <Button onClick={() => void handleSave()} disabled={saving || envError !== null} aria-busy={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

export function ProjectSettingsDialog() {
  const savingRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const { spine, bootstrap, projectSettingsTarget } = useYaran()
  const project = projectSettingsTarget === null
    ? undefined
    : spine?.projects.find((p) => p.id === projectSettingsTarget)
  // Closes the dialog when the project vanishes from the ViewModel; this is
  // orthogonal to the save flow above, which deliberately stays open on a
  // rejected save. See the hook.
  const open = useVanishedTargetGuard(
    projectSettingsTarget !== null,
    project !== undefined,
    closeProjectSettings,
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !savingRef.current) closeProjectSettings()
      }}
    >
      {open && project && (
        <ProjectSettingsForm
          key={project.id}
          saving={saving}
          setSaving={setSaving}
          savingRef={savingRef}
          project={project}
          providers={bootstrap?.available_providers ?? []}
        />
      )}
    </Dialog>
  )
}
