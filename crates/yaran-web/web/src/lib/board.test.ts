import { describe, expect, it } from "vitest"

import { assignable, boardSections, defaultQueue, inQueue, waitingCount } from "./board"
import type { BoardCard } from "./boardApi"

function card(over: Partial<BoardCard>): BoardCard {
  return {
    id: 1,
    kind: "task",
    title: "t",
    created_at: "2026-11-19T00:00:00Z",
    updated_at: "2026-11-19T00:00:00Z",
    label: "#1",
    waiting: false,
    reply_agent: null,
    ...over,
  }
}

describe("board", () => {
  it("puts an unassigned card in every queue and an assigned one in its person's", () => {
    expect(inQueue(card({}), "Sam")).toBe(true)
    expect(inQueue(card({ assignee: "sam " }), "Sam")).toBe(true)
    expect(inQueue(card({ assignee: "Alex" }), "Sam")).toBe(false)
    expect(inQueue(card({ assignee: "Alex" }), null)).toBe(true)
  })

  it("opens on me's queue, else the first person's, else every card", () => {
    expect(defaultQueue({ people: ["Sam", "Alex"], me: "alex" })).toBe("Alex")
    expect(defaultQueue({ people: ["Sam", "Alex"], me: null })).toBe("Sam")
    expect(defaultQueue({ people: [], me: "Sam" })).toBe(null)
  })

  it("groups open cards by kind in board order, Done last, empty groups left out", () => {
    const cards = [
      card({ id: 1, kind: "info" }),
      card({ id: 2, kind: "task" }),
      card({ id: 3, kind: "confirm", resolved_at: "2026-11-19T01:00:00Z" }),
    ]
    expect(boardSections(cards, null).map((s) => [s.heading, s.cards.map((c) => c.id)])).toEqual([
      ["Tasks for you", [2]],
      ["What happened", [1]],
      ["Done", [3]],
    ])
  })

  it("counts open cards that wait on a person, not news", () => {
    const cards = [
      card({ id: 1, kind: "info" }),
      card({ id: 2, kind: "validate" }),
      card({ id: 3, kind: "task", assignee: "Alex" }),
    ]
    expect(waitingCount(cards, null)).toBe(2)
    expect(waitingCount(cards, "Sam")).toBe(1)
  })

  it("hands over only open tasks, and only on a board with more than one person", () => {
    const people = ["Sam", "Alex"]
    expect(assignable(card({ kind: "task" }), people)).toBe(true)
    expect(assignable(card({ kind: "confirm" }), people)).toBe(false)
    expect(assignable(card({ kind: "task", resolved_at: "2026-11-19T01:00:00Z" }), people)).toBe(false)
    expect(assignable(card({ kind: "task" }), ["Sam"])).toBe(false)
  })
})
