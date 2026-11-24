import { useEffect, useState } from "react"
import { Button } from "@yaran/ui-kit/button"
import { Checkbox } from "@yaran/ui-kit/checkbox"
import { Input } from "@yaran/ui-kit/input"
import { InlineCode } from "@yaran/ui-kit/inline-code"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@yaran/ui-kit/dialog"
import { jcodeModelsApi, type ModelChange, type ModelTarget } from "@/lib/jcodeModelsApi"
import { closeJcodeModels, useYaran } from "@/lib/store"

export function JcodeModelsDialog() {
  const { jcodeModelsOpen } = useYaran()
  const [busy, setBusy] = useState(false)
  return <Dialog open={jcodeModelsOpen} onOpenChange={(open, details) => {
    if (busy) details.cancel()
    else if (!open) closeJcodeModels()
  }}>
    <DialogContent>{jcodeModelsOpen ? <Body busy={busy} setBusy={setBusy} /> : null}</DialogContent>
  </Dialog>
}

function Body({ busy, setBusy }: { busy: boolean; setBusy: (busy: boolean) => void }) {
  const [targets, setTargets] = useState<ModelTarget[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [model, setModel] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<ModelChange[]>([])

  useEffect(() => {
    const controller = new AbortController()
    void jcodeModelsApi.targets(controller.signal).then(setTargets).catch(error => {
      if (!controller.signal.aborted) setError(String(error))
    })
    return () => controller.abort()
  }, [])

  function toggle(id: string) {
    setSelected(previous => {
      const next = new Set(previous)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !selected.size || !model.trim()) return
    setBusy(true)
    setError(null)
    setOutcomes([])
    try {
      setOutcomes(await jcodeModelsApi.change([...selected], model.trim()))
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }

  return <form onSubmit={event => { void submit(event) }} className="grid gap-4">
    <DialogHeader>
      <DialogTitle>Change jcode models</DialogTitle>
      <DialogDescription>Choose running jcodes and enter one model ID. Conversations and drafts stay in place. Jcode control must be enabled. Find model IDs with <InlineCode>jcode model list</InlineCode>.</DialogDescription>
    </DialogHeader>
    <label className="grid gap-2 text-sm">Model ID
      <Input value={model} onChange={event => setModel(event.target.value)} disabled={busy} maxLength={256} autoFocus required />
    </label>
    <Button type="button" variant="outline" disabled={busy || !targets?.length} onClick={() => {
      setSelected(selected.size === targets?.length ? new Set() : new Set(targets?.map(target => target.tab_id)))
    }}>{targets?.length && selected.size === targets.length ? "Clear selection" : "Select all running jcodes"}</Button>
    <div className="max-h-64 space-y-2 overflow-y-auto" aria-label="Running jcodes">
      {targets === null && !error ? <p role="status">Loading running jcodes…</p> : null}
      {targets?.length === 0 ? <p>No running jcode tabs.</p> : null}
      {targets?.map(target => <label key={target.tab_id} className="flex min-h-10 items-center gap-3 rounded-md px-2 text-sm">
        <Checkbox checked={selected.has(target.tab_id)} onCheckedChange={() => toggle(target.tab_id)} disabled={busy} />
        <span>{target.label}<span className="ml-2 text-muted-foreground">{target.tab_id}</span></span>
      </label>)}
    </div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {outcomes.length ? <div aria-live="polite" className="max-h-48 space-y-2 overflow-y-auto text-sm">
      <p>{outcomes.filter(outcome => !outcome.error).length} changed, {outcomes.filter(outcome => outcome.error).length} failed.</p>
      {outcomes.map(outcome => <p key={outcome.tab_id}><InlineCode>{outcome.label}</InlineCode>: {outcome.error ?? "Model changed."}</p>)}
    </div> : null}
    <DialogFooter>
      <Button type="button" variant="outline" disabled={busy} onClick={closeJcodeModels}>Close</Button>
      <Button type="submit" disabled={busy || !selected.size || !model.trim()}>{busy ? "Changing models…" : `Change ${selected.size} jcode${selected.size === 1 ? "" : "s"}`}</Button>
    </DialogFooter>
  </form>
}
