import { useRef, useState } from "react"
import { TriangleAlert } from "lucide-react"
import { Button } from "@yaran/ui-kit/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@yaran/ui-kit/dialog"
import { Textarea } from "@/components/ui/textarea"
import { envToText, parseEnv, validateEnv } from "@/lib/env"
import {
  closeGlobalEnv,
  dismissGlobalEnvConflict,
  reloadGlobalEnvDraft,
  saveGlobalEnv,
  useYaran,
} from "@/lib/store"

// The form body is a separate component mounted only while the dialog is open.
// It seeds its `useState` from the `env` prop via a lazy initializer, so there
// is no set-state-in-effect to seed the textarea on open.
function GlobalEnvForm({
  env,
  conflict,
  saving,
  setSaving,
  savingRef,
}: {
  env: Record<string, string>
  conflict: string | null
  saving: boolean
  setSaving: (value: boolean) => void
  savingRef: React.RefObject<boolean>
}) {
  const [text, setText] = useState(() => envToText(env))
  const envError = validateEnv(text)

  async function handleSave() {
    if (savingRef.current || envError) return
    savingRef.current = true
    setSaving(true)
    try {
      if (await saveGlobalEnv(parseEnv(text))) closeGlobalEnv()
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <DialogContent showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>Global environment</DialogTitle>
        <DialogDescription>
          KEY=VALUE per line. Applied to new agents and terminals unless a
          project overrides the same key.
        </DialogDescription>
      </DialogHeader>
      <Textarea
        aria-label="Global environment variables"
        aria-invalid={envError !== null}
        aria-describedby={envError ? "global-env-error" : undefined}
        disabled={saving}
        placeholder="KEY=VALUE"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="min-h-48 font-mono"
        autoFocus={conflict === null}
      />
      {envError && <p id="global-env-error" role="alert" className="text-sm text-destructive">{envError}</p>}
      {conflict ? (
        // The table changed after the dialog read it and nothing was saved.
        // Reloading throws these edits away, so "Keep editing" has focus.
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm"
        >
          <div className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <span>{conflict}</span>
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="outline" autoFocus onClick={dismissGlobalEnvConflict}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={() => void reloadGlobalEnvDraft()}>
              Reload the environment
            </Button>
          </div>
        </div>
      ) : null}
      <DialogFooter>
        <Button variant="outline" disabled={saving} onClick={closeGlobalEnv}>
          Cancel
        </Button>
        <Button onClick={() => void handleSave()} disabled={saving || envError !== null} aria-busy={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

export function GlobalEnvDialog() {
  const { bootstrap, globalEnvOpen, globalEnvDraft, globalEnvConflict, globalEnvEpoch } =
    useYaran()
  // Keep one write attached to its form until it settles, including dismissals.
  const savingRef = useRef(false)
  const [saving, setSaving] = useState(false)

  return (
    <Dialog
      open={globalEnvOpen}
      onOpenChange={(o) => {
        if (!o && !savingRef.current) closeGlobalEnv()
      }}
    >
      {globalEnvOpen && (
        <GlobalEnvForm
          key={globalEnvEpoch}
          env={globalEnvDraft ?? bootstrap?.global_env ?? {}}
          conflict={globalEnvConflict}
          saving={saving}
          setSaving={setSaving}
          savingRef={savingRef}
        />
      )}
    </Dialog>
  )
}
