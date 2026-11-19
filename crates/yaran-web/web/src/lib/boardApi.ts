// HTTP client for the human board ("Tasks for Human"): the cards agents post
// with `yaran board post`. Mirrors `crates/yaran-web/src/board_routes.rs`.

import { createJsonRequest } from "./jsonRequest"

export type CardKind = "task" | "validate" | "confirm" | "info"
export type CardPriority = "critical" | "high" | "normal" | "low"

export interface BoardMessage {
  at: string
  from: string
  side?: string
  text: string
  done?: boolean
}

export interface BoardCard {
  /** A number, or a prefixed string such as `"G-5"` on a shared board. */
  id: number | string
  kind: CardKind
  /** Absent for the ordinary queue. */
  priority?: CardPriority
  assignee?: string
  ticket?: string
  title: string
  detail?: string
  from?: string
  created_at: string
  updated_at: string
  resolved_at?: string
  resolved_by?: string
  resolution?: string
  thread?: BoardMessage[]
  /** `#12`, or `#12 [4812]`. */
  label: string
  /** The poster cannot carry on until a person answers. */
  waiting: boolean
  /** The running agent a reply is sent to; null when it only joins the conversation. */
  reply_agent: string | null
}

export interface BoardView {
  people: string[]
  me: string | null
  /** Open cards in the board's order, then the recently resolved. */
  cards: BoardCard[]
  problems: string[]
}

export class BoardApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "BoardApiError"
    this.status = status
  }
}

const request = createJsonRequest(
  (message, status) => new BoardApiError(message, status),
)

const cardPath = (id: BoardCard["id"], action: string) =>
  `/api/v1/board/cards/${encodeURIComponent(String(id))}/${action}`

export const boardApi = {
  get: () => request<BoardView>("GET", "/api/v1/board"),
  resolve: (id: BoardCard["id"]) =>
    request<{ changed: boolean }>("POST", cardPath(id, "resolve")),
  reopen: (id: BoardCard["id"]) =>
    request<{ changed: boolean }>("POST", cardPath(id, "reopen")),
  /** `person` null hands the card to nobody in particular. */
  assign: (id: BoardCard["id"], person: string | null) =>
    request<{ changed: boolean }>("POST", cardPath(id, "assign"), { person }),
  priority: (id: BoardCard["id"], priority: CardPriority) =>
    request<{ changed: boolean }>("POST", cardPath(id, "priority"), { priority }),
  reply: (id: BoardCard["id"], text: string, done: boolean) =>
    request<{ sent_to: string | null }>("POST", cardPath(id, "reply"), {
      text,
      done,
    }),
}
