import { expect, it } from "vitest"
import { flatRowKey, listDragBaseline, planListDrop } from "./flatList"
import type { SessionView } from "./types"

const agent = (id: string, project: string) => ({
  id, title: id, status: "active", working: false,
  workspace: { kind: "managed", project_id: project },
} as SessionView)

it("a grouped drag preserves unrelated projects' stored order, as the TUI does", () => {
  const sessions = [agent("c0", "c"), agent("a0", "a"), agent("b0", "b"), agent("a1", "a")]
  const baseline = listDragBaseline(sessions, [], "manual", ["a", "b", "c"])
  const key = (id: string) => flatRowKey(baseline.find((row) => row.kind === "agent" && row.session.id === id)!)
  expect(planListDrop(baseline, key("a0"), key("a1"), sessions, [], true)).toEqual({
    agentOrder: ["c0", "b0", "a1", "a0"], placements: {}, terminalOrder: null,
  })
})

it("a computed-sort drop restoring stored order still requests the flip to manual", () => {
  const sessions = [agent("b", "a"), agent("a", "a")]
  const baseline = listDragBaseline(sessions, [], "name", ["a"])
  expect(planListDrop(baseline, flatRowKey(baseline[0]), flatRowKey(baseline[1]), sessions, [], true, "name")).toEqual({
    agentOrder: null, placements: {}, terminalOrder: null,
  })
})
