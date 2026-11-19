// Pure decisions for the Board dialog: which queue a card is in, and how the
// list groups. The groups and their order mirror the terminal UI's board
// (`yaran_core::human_board::CardKind::heading`), and the server already sends
// the open cards in board order (kind, urgency, newest first).

import type { BoardCard, BoardView, CardKind, CardPriority } from "./boardApi"

const HEADINGS: Record<CardKind, string> = {
  task: "Tasks for you",
  validate: "Validation",
  confirm: "Confirmation needed",
  info: "What happened",
}
const KIND_ORDER: CardKind[] = ["task", "validate", "confirm", "info"]
export const DONE_HEADING = "Done"

/** Names are matched case-insensitively, ignoring surrounding space, as core does. */
export function samePerson(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export function isOpen(card: BoardCard): boolean {
  return card.resolved_at === undefined || card.resolved_at === null
}

/** Whether `card` is in `queue`: a person's (assigned to them or to nobody), or every card (`null`). */
export function inQueue(card: BoardCard, queue: string | null): boolean {
  if (queue === null || card.assignee === undefined) return true
  return samePerson(card.assignee, queue)
}

/** The queue the dialog opens on: `me`'s when they are on the board, else the first person's, else every card. */
export function defaultQueue(view: Pick<BoardView, "people" | "me">): string | null {
  const mine = view.me === null ? undefined : view.people.find((p) => samePerson(p, view.me!))
  return mine ?? view.people[0] ?? null
}

export interface BoardSection {
  heading: string
  cards: BoardCard[]
}

/** The list's groups for `queue`, empty groups left out, Done last. */
export function boardSections(cards: BoardCard[], queue: string | null): BoardSection[] {
  const shown = cards.filter((c) => inQueue(c, queue))
  const sections: BoardSection[] = KIND_ORDER.map((kind) => ({
    heading: HEADINGS[kind],
    cards: shown.filter((c) => isOpen(c) && c.kind === kind),
  }))
  sections.push({ heading: DONE_HEADING, cards: shown.filter((c) => !isOpen(c)) })
  return sections.filter((s) => s.cards.length > 0)
}

/** How many open cards in `queue` wait on a person (news waits on nobody). */
export function waitingCount(cards: BoardCard[], queue: string | null): number {
  return cards.filter((c) => isOpen(c) && c.kind !== "info" && inQueue(c, queue)).length
}

/**
 * Whether `card` can be handed to someone else's queue: an open task on a board
 * with more than one person, as in the terminal UI. News, validations and
 * confirmations stay with whoever they were posted for.
 */
export function assignable(card: BoardCard, people: string[]): boolean {
  return isOpen(card) && card.kind === "task" && people.length > 1
}

export const PRIORITIES: CardPriority[] = ["critical", "high", "normal", "low"]

/** The marker a list row wears for an unusual priority, as the terminal UI's. */
export function priorityMarker(card: BoardCard): string | null {
  switch (card.priority) {
    case "critical":
      return "!!"
    case "high":
      return "!"
    case "low":
      return "↓"
    default:
      return null
  }
}
