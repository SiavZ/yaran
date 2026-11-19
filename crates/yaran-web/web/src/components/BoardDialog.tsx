import {
  ArrowLeft,
  Check,
  ChevronDown,
  Flag,
  RotateCcw,
  Send,
  TriangleAlert,
  UserRound,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"

import { Textarea } from "@/components/ui/textarea"
import { Button } from "@yaran/ui-kit/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@yaran/ui-kit/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@yaran/ui-kit/dropdown-menu"
import { InlineCode } from "@yaran/ui-kit/inline-code"
import { cn } from "@yaran/ui-kit/cn"
import {
  PRIORITIES,
  assignable,
  boardSections,
  defaultQueue,
  isOpen,
  priorityMarker,
  waitingCount,
} from "@/lib/board"
import {
  boardApi,
  type BoardCard,
  type BoardView,
  type CardPriority,
} from "@/lib/boardApi"
import { notifyError, notifySuccess, type Notice } from "@/lib/notify"
import { chip, prose } from "@/lib/prose"
import { relativeTime } from "@/lib/relativeTime"
import { closeBoard, useYaran } from "@/lib/store"

// The human board ("Tasks for Human"): the cards agents post with
// `yaran board post` for the people running yaran, on every device, the phone
// included. The terminal UI shows the same board in its right column.
//
// shortcut: the board is re-read every few seconds while the dialog is open and
// the page visible, because nothing on the events socket says the board file
// changed; push a board-changed event if the poll ever costs too much.
const BOARD_POLL_MS = 3000

export function BoardDialog() {
  const { boardOpen } = useYaran()
  return (
    <Dialog open={boardOpen} onOpenChange={(open) => (open ? null : closeBoard())}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-[min(44rem,calc(100%-2rem))]"
      >
        {/* Mounted only while open, so the selected queue and card reset on close
            and the poll stops with the effect's cleanup. */}
        {boardOpen ? <BoardBody /> : null}
      </DialogContent>
    </Dialog>
  )
}

function BoardBody() {
  const [view, setView] = useState<BoardView | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // `undefined` until the first read picks the default queue; `null` is every card.
  const [queue, setQueue] = useState<string | null | undefined>(undefined)
  const [openId, setOpenId] = useState<BoardCard["id"] | null>(null)

  const load = useCallback(async () => {
    try {
      const next = await boardApi.get()
      setView(next)
      setFailure(null)
      setQueue((q) => (q === undefined ? defaultQueue(next) : q))
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    async function tick() {
      if (cancelled || document.hidden) return
      await load()
      if (!cancelled) timer = setTimeout(tick, BOARD_POLL_MS)
    }
    function onVisibility() {
      if (timer !== undefined) clearTimeout(timer)
      if (!document.hidden) void tick()
    }
    document.addEventListener("visibilitychange", onVisibility)
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [load])

  const card = view?.cards.find((c) => c.id === openId) ?? null
  if (card !== null) {
    return (
      <CardView
        card={card}
        people={view?.people ?? []}
        onBack={() => setOpenId(null)}
        onChanged={load}
      />
    )
  }
  return (
    <BoardList
      view={view}
      failure={failure}
      queue={queue ?? null}
      onQueue={setQueue}
      onOpen={setOpenId}
    />
  )
}

function BoardList({
  view,
  failure,
  queue,
  onQueue,
  onOpen,
}: {
  view: BoardView | null
  failure: string | null
  queue: string | null
  onQueue: (queue: string | null) => void
  onOpen: (id: BoardCard["id"]) => void
}) {
  const cards = useMemo(() => view?.cards ?? [], [view])
  const sections = useMemo(() => boardSections(cards, queue), [cards, queue])
  const queues: (string | null)[] = view && view.people.length > 0 ? [...view.people, null] : []
  return (
    <>
      <DialogHeader>
        <DialogTitle>Tasks for Human</DialogTitle>
        <DialogDescription>
          What agents need a person for: decisions, checks and confirmations.
          Agents post here with <InlineCode>yaran board post</InlineCode>.
        </DialogDescription>
      </DialogHeader>

      {failure !== null ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          Could not read the board: {failure}
        </p>
      ) : null}

      {queues.length > 0 ? (
        // One button per person's queue, then every card. A plain button row
        // rather than tabs: the list below is the same list, narrowed.
        <div role="group" aria-label="Queue" className="flex flex-wrap gap-2">
          {queues.map((q) => (
            <Button
              key={q ?? "*all"}
              size="sm"
              variant={q === queue ? "default" : "outline"}
              aria-pressed={q === queue}
              className="pointer-coarse:h-10"
              onClick={() => onQueue(q)}
            >
              {q ?? "All"}
              <span className="tabular-nums opacity-70">{waitingCount(cards, q)}</span>
            </Button>
          ))}
        </div>
      ) : null}

      <div className="max-h-[60vh] overflow-y-auto pr-2 [scrollbar-gutter:stable]">
        {view !== null && sections.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nothing waits on you. Cards agents post show up here.
          </p>
        ) : null}
        {sections.map((section) => (
          <section key={section.heading} className="mb-3">
            <h3 className="px-2 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              {section.heading} ({section.cards.length})
            </h3>
            <ul className="flex flex-col gap-1">
              {section.cards.map((c) => (
                <li key={String(c.id)}>
                  <CardRow card={c} showAssignee={queue === null && queues.length > 0} onOpen={onOpen} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <DialogFooter>
        <Button variant="outline" autoFocus onClick={closeBoard}>
          Done
        </Button>
      </DialogFooter>
    </>
  )
}

function CardRow({
  card,
  showAssignee,
  onOpen,
}: {
  card: BoardCard
  showAssignee: boolean
  onOpen: (id: BoardCard["id"]) => void
}) {
  const marker = priorityMarker(card)
  const done = !isOpen(card)
  return (
    <button
      type="button"
      onClick={() => onOpen(card.id)}
      className={cn(
        "flex min-h-10 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
        done && "text-muted-foreground",
      )}
    >
      <span className="w-4 shrink-0 text-center font-semibold text-destructive" aria-label={card.priority}>
        {marker}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{card.label}</span>
      <span className={cn("min-w-0 flex-1 truncate", done && "line-through")}>{card.title}</span>
      {card.waiting ? (
        <span className="shrink-0 rounded bg-destructive/15 px-1.5 text-xs text-destructive">
          blocking
        </span>
      ) : null}
      {showAssignee && card.assignee ? (
        <span className="shrink-0 text-xs text-muted-foreground">{card.assignee}</span>
      ) : null}
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {relativeTime(card.updated_at)}
      </span>
    </button>
  )
}

function CardView({
  card,
  people,
  onBack,
  onChanged,
}: {
  card: BoardCard
  people: string[]
  onBack: () => void
  onChanged: () => Promise<void>
}) {
  const [reply, setReply] = useState("")
  const [busy, setBusy] = useState(false)
  const open = isOpen(card)

  async function act(work: () => Promise<Notice>) {
    setBusy(true)
    try {
      notifySuccess(await work())
      await onChanged()
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const send = (done: boolean) =>
    act(async () => {
      const text = reply.trim()
      if (text === "") {
        await boardApi.resolve(card.id)
        return prose`Marked card ${chip(card.label)} done.`
      }
      const answer = await boardApi.reply(card.id, text, done)
      setReply("")
      const where =
        answer.sent_to === null
          ? prose`added to the conversation on card ${chip(card.label)}`
          : prose`sent to ${chip(answer.sent_to)} and kept on card ${chip(card.label)}`
      return prose`Your reply was ${where}${done ? ", and the card is done" : ""}.`
    })

  const reopen = () =>
    act(async () => {
      await boardApi.reopen(card.id)
      return prose`Card ${chip(card.label)} is open again.`
    })

  const setPriority = (priority: CardPriority) =>
    act(async () => {
      const { changed } = await boardApi.priority(card.id, priority)
      return changed
        ? prose`Card ${chip(card.label)} is now ${priority} priority.`
        : prose`Card ${chip(card.label)} already was ${priority} priority.`
    })

  const assign = (person: string | null) =>
    act(async () => {
      const { changed } = await boardApi.assign(card.id, person)
      const queue = person === null ? prose`everybody's queue` : prose`the queue of ${chip(person)}`
      return changed
        ? prose`Card ${chip(card.label)} is now in ${queue}.`
        : prose`Card ${chip(card.label)} already was in ${queue}.`
    })

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="pointer-coarse:size-10"
            aria-label="Back to the board"
            onClick={onBack}
          >
            <ArrowLeft />
          </Button>
          <DialogTitle className="min-w-0 flex-1">{card.title}</DialogTitle>
        </div>
        <DialogDescription>
          <InlineCode>{card.label}</InlineCode> · {card.kind}
          {card.priority ? ` · ${card.priority}` : ""}
          {card.from ? (
            <>
              {" "}· from <InlineCode>{card.from}</InlineCode>
            </>
          ) : null}
          {card.assignee ? (
            <>
              {" "}· for <InlineCode>{card.assignee}</InlineCode>
            </>
          ) : null}
          {" "}· {relativeTime(card.created_at)}
          {card.waiting ? " · the agent is waiting on an answer" : ""}
        </DialogDescription>
      </DialogHeader>

      {open ? (
        <div className="flex flex-wrap gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  className="pointer-coarse:h-10"
                />
              }
            >
              <Flag />
              Priority: {card.priority ?? "normal"}
              <ChevronDown className="opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {PRIORITIES.map((p) => (
                <DropdownMenuItem key={p} onClick={() => void setPriority(p)}>
                  {(card.priority ?? "normal") === p ? <Check /> : <span className="size-4" />}
                  {p}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {assignable(card, people) ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    className="pointer-coarse:h-10"
                  />
                }
              >
                <UserRound />
                Assign
                <ChevronDown className="opacity-60" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {[...people, null].map((person) => (
                  <DropdownMenuItem
                    key={person ?? "*anyone"}
                    onClick={() => void assign(person)}
                  >
                    {(card.assignee ?? null) === person ? <Check /> : <span className="size-4" />}
                    {person ?? "Anyone"}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}

      <div className="max-h-[50vh] overflow-y-auto pr-2 text-sm [scrollbar-gutter:stable]">
        {card.detail ? <p className="whitespace-pre-wrap">{card.detail}</p> : null}
        {(card.thread ?? []).length > 0 ? (
          <ol className="mt-3 flex flex-col gap-2 border-t pt-3">
            {(card.thread ?? []).map((m) => (
              <li key={`${m.at}|${m.from}`} className="rounded-md bg-muted/50 px-2 py-1.5">
                <div className="text-xs text-muted-foreground">
                  {m.from} · {relativeTime(m.at)}
                  {m.done ? " · marked done" : ""}
                </div>
                <p className="whitespace-pre-wrap">{m.text}</p>
              </li>
            ))}
          </ol>
        ) : null}
        {!open ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Done{card.resolved_by ? ` by ${card.resolved_by}` : ""}
            {card.resolved_at ? ` (${relativeTime(card.resolved_at)})` : ""}
            {card.resolution ? `: ${card.resolution}` : "."}
          </p>
        ) : null}
      </div>

      {open ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">
            {card.reply_agent !== null ? (
              <>
                Your reply goes to <InlineCode>{card.reply_agent}</InlineCode>, which
                posted it, and is kept on the card.
              </>
            ) : (
              <>Your reply joins the card&apos;s conversation.</>
            )}
          </p>
          <Textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Reply…"
            rows={3}
            disabled={busy}
          />
        </div>
      ) : null}

      {/* Misclick-safe spacing between the reply box and the buttons. */}
      <div className="h-2" />
      <DialogFooter>
        {open ? (
          <>
            <Button
              variant="outline"
              className="pointer-coarse:h-10"
              disabled={busy || reply.trim() === ""}
              onClick={() => void send(false)}
            >
              <Send /> Send
            </Button>
            <Button className="pointer-coarse:h-10" disabled={busy} onClick={() => void send(true)}>
              <Check /> {reply.trim() === "" ? "Mark done" : "Send & mark done"}
            </Button>
          </>
        ) : (
          <Button variant="outline" className="pointer-coarse:h-10" disabled={busy} onClick={() => void reopen()}>
            <RotateCcw /> Reopen
          </Button>
        )}
      </DialogFooter>
    </>
  )
}
