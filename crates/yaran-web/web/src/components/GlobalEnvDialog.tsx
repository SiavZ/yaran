import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { envToText, parseEnv, validateEnv } from "@/lib/env"
import { closeGlobalEnv, saveGlobalEnv, useYaran } from "@/lib/store"

// The form body is a separate component mounted only while the dialog is open.
// It seeds its `useState` from the `env` prop via a lazy initializer, so there
// is no set-state-in-effect to seed the textarea on open.
function GlobalEnvForm({ env, saving, setSaving, savingRef }: {
  env: Record<string, string>
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
        autoFocus
      />
      {envError && <p id="global-env-error" role="alert" className="text-sm text-destructive">{envError}</p>}
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
  const { bootstrap, globalEnvOpen } = useYaran()
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
      {globalEnvOpen && <GlobalEnvForm env={bootstrap?.global_env ?? {}} saving={saving} setSaving={setSaving} savingRef={savingRef} />}
    </Dialog>
  )
}
