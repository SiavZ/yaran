import { useEffect, useMemo, useState } from "react"
import { Button } from "@yaran/ui-kit/button"
import { Checkbox } from "@yaran/ui-kit/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@yaran/ui-kit/select"
import { InlineCode } from "@yaran/ui-kit/inline-code"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@yaran/ui-kit/dialog"
import { jcodeModelsApi, type ModelChange, type ModelChoice, type ModelTarget } from "@/lib/jcodeModelsApi"
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
  const [choices, setChoices] = useState<ModelChoice[] | null>([])
  const [choiceId, setChoiceId] = useState("")
  const [reasoning, setReasoning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<ModelChange[]>([])
  const runs = useMemo(() => Object.fromEntries(targets?.filter(target => selected.has(target.tab_id)).map(target => [target.tab_id, target.run_id]) ?? []), [targets, selected])
  const choice = choices?.find(choice => choice.id === choiceId)

  useEffect(() => {
    const controller = new AbortController()
    void jcodeModelsApi.targets(controller.signal).then(setTargets).catch(error => {
      if (!controller.signal.aborted) setError(String(error))
    })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!Object.keys(runs).length) return
    const controller = new AbortController()
    void jcodeModelsApi.catalog(runs, controller.signal).then(choices => {
      if (!controller.signal.aborted) setChoices(choices)
    }).catch(error => {
      if (!controller.signal.aborted) { setChoices([]); setError(String(error)) }
    })
    return () => controller.abort()
  }, [runs])

  function selectTargets(next: Set<string>) {
    setSelected(next)
    setChoices(next.size ? null : [])
    setChoiceId("")
    setReasoning(null)
    setError(null)
    setOutcomes([])
  }

  function toggle(id: string) {
    const next = new Set(selected)
    if (!next.delete(id)) next.add(id)
    selectTargets(next)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !selected.size || !choice?.available || (choice.reasoning_levels.length && !reasoning)) return
    setBusy(true)
    setError(null)
    setOutcomes([])
    try {
      setOutcomes(await jcodeModelsApi.change(runs, choice.id, reasoning))
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }

  return <form onSubmit={event => { void submit(event) }} className="grid gap-4">
    <DialogHeader>
      <DialogTitle>Change jcode models</DialogTitle>
      <DialogDescription>Select running jcodes, then choose a model, provider, and reasoning level from their native <InlineCode>/models</InlineCode> choices. Only shared routes and levels are offered. Conversations and drafts stay in place.</DialogDescription>
    </DialogHeader>
    <Button type="button" variant="outline" disabled={busy || !targets?.length} onClick={() => {
      selectTargets(selected.size === targets?.length ? new Set() : new Set(targets?.map(target => target.tab_id)))
    }}>{targets?.length && selected.size === targets.length ? "Clear selection" : "Select all running jcodes"}</Button>
    <div className="max-h-64 space-y-2 overflow-y-auto" aria-label="Running jcodes">
      {targets === null && !error ? <p role="status">Loading running jcodes…</p> : null}
      {targets?.length === 0 ? <p>No running jcode tabs.</p> : null}
      {targets?.map(target => <label key={target.tab_id} className="flex min-h-10 items-center gap-3 rounded-md px-2 text-sm">
        <Checkbox checked={selected.has(target.tab_id)} onCheckedChange={() => toggle(target.tab_id)} disabled={busy} />
        <span>{target.label}<span className="ml-2 text-muted-foreground">{target.tab_id}</span></span>
      </label>)}
    </div>
    <div className="grid gap-2 text-sm">
      <label htmlFor="jcode-model-choice">Model and provider</label>
      <Select value={choiceId || null} disabled={busy || !choices?.length} onValueChange={value => {
        setChoiceId(value ?? "")
        setReasoning(choices?.find(choice => choice.id === value)?.reasoning_effort ?? null)
      }}>
        <SelectTrigger id="jcode-model-choice" className="w-full"><SelectValue placeholder="Choose a native model and provider">{choice ? `${choice.name} · ${choice.provider} · ${choice.api_method}` : undefined}</SelectValue></SelectTrigger>
        <SelectContent>{choices?.map(choice => <SelectItem key={choice.id} value={choice.id} disabled={!choice.available}>
          {choice.name} · {choice.provider} · {choice.api_method}
        </SelectItem>)}</SelectContent>
      </Select>
      {choices === null ? <p role="status">Loading native model choices…</p> : selected.size && !choices.length && !error ? <p>No shared model/provider choices. Select fewer jcodes or open their native /models catalog and retry.</p> : null}
      {choice?.detail ? <p className="text-muted-foreground">{choice.detail}</p> : null}
      <label htmlFor="jcode-reasoning">Reasoning level</label>
      <Select value={reasoning} disabled={busy || !choice?.reasoning_levels.length} onValueChange={value => setReasoning(value)}>
        <SelectTrigger id="jcode-reasoning" className="w-full"><SelectValue placeholder={choice ? "No reasoning choice for this route" : "Choose a model first"}>{choice?.reasoning_levels.find(level => level.value === reasoning)?.label}</SelectValue></SelectTrigger>
        <SelectContent>{choice?.reasoning_levels.map(level => <SelectItem key={level.value} value={level.value}>{level.label}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {outcomes.length ? <div aria-live="polite" className="max-h-48 space-y-2 overflow-y-auto text-sm">
      <p>{outcomes.filter(outcome => !outcome.error).length} applied, {outcomes.filter(outcome => outcome.error).length} failed or partial.</p>
      {outcomes.map(outcome => <p key={outcome.tab_id}><InlineCode>{outcome.label}</InlineCode> <InlineCode>{outcome.tab_id}</InlineCode>: {outcome.error ?? "Native choice applied."}</p>)}
    </div> : null}
    <DialogFooter>
      <Button type="button" variant="outline" disabled={busy} onClick={closeJcodeModels}>Close</Button>
      <Button type="submit" disabled={busy || !selected.size || !choice?.available || Boolean(choice.reasoning_levels.length && !reasoning)}>{busy ? "Changing models…" : `Change ${selected.size} jcode${selected.size === 1 ? "" : "s"}`}</Button>
    </DialogFooter>
  </form>
}
