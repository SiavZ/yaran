// The same live TL;DR above hub conversations on a phone and a computer.

import { useEffect, useState } from "react"
import { Button } from "@yaran/ui-kit/button"
import { InlineCode } from "@yaran/ui-kit/inline-code"
import { boardApi, type BoardCard } from "@/lib/boardApi"
import { relativeTime } from "@/lib/relativeTime"

export function BoardCardSummary({ card, busy }: { card: BoardCard; busy: boolean }) {
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const { id, summary, summary_revision: revision, summary_current: current, summary_agent: agent } = card
  const key = `${id}|${revision}|${attempt}`
  const failure = error?.key === key ? error.message : null

  useEffect(() => {
    if (current || !revision || !agent) return
    let cancelled = false
    const timer = setTimeout(() => {
      setError({ key, message: "The agent hasn't updated the TL;DR yet." })
    }, 60_000)
    void boardApi.requestSummary(id).catch((error: unknown) => {
      if (cancelled) return
      clearTimeout(timer)
      setError({ key, message: error instanceof Error ? error.message : String(error) })
    })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [id, revision, current, agent, key])

  return (
    <section aria-label="TL;DR" className="allow-select rounded-md border bg-muted/40 p-3 text-sm">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">TL;DR</h3>
        <span role="status" className="text-xs text-muted-foreground">
          {current && summary ? `Up to date · ${relativeTime(summary.at)}` : "Needs updating"}
        </span>
      </div>
      {summary ? <p className="whitespace-pre-wrap">{summary.text}</p> : null}
      {!current ? (
        <div className="mt-1 text-xs text-muted-foreground">
          {summary ? <p>Newer changes aren't covered in this summary.</p> : null}
          {!agent ? (
            <p>Start this card's agent or the board's receiving agent to get an up-to-date TL;DR.</p>
          ) : failure ? (
            <>
              <p role="status">{failure}</p>
              <Button variant="outline" size="sm" className="mt-2 pointer-coarse:h-10" disabled={busy} onClick={() => setAttempt(attempt + 1)}>
                Retry TL;DR
              </Button>
            </>
          ) : (
            <p role="status">Updating with <InlineCode>{agent}</InlineCode>…</p>
          )}
        </div>
      ) : null}
    </section>
  )
}
