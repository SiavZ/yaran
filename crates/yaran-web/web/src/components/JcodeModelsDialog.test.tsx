// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

vi.mock("@/lib/store", () => ({ useYaran: () => ({ jcodeModelsOpen: true }), closeJcodeModels: vi.fn() }))
vi.mock("@/lib/jcodeModelsApi", () => ({ jcodeModelsApi: { targets: vi.fn(), catalog: vi.fn(), change: vi.fn() } }))
import { JcodeModelsDialog } from "./JcodeModelsDialog"
import { jcodeModelsApi, type ModelChoice } from "@/lib/jcodeModelsApi"

const choices: ModelChoice[] = [
  { id: "native-oauth", name: "same-model", provider: "OAuth account", api_method: "openai-oauth", available: true, detail: "Native OAuth route", reasoning_effort: "high", reasoning_levels: [{ value: "high", label: "OAuth High" }] },
  { id: "native-api", name: "same-model", provider: "API provider", api_method: "openai-api-key", available: true, detail: "Native API route", reasoning_effort: "future-max", reasoning_levels: [{ value: "future-low", label: "API Low" }, { value: "future-max", label: "API Max" }] },
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(jcodeModelsApi.targets).mockResolvedValue([{ tab_id: "a", label: "Agent A", run_id: "run-a" }, { tab_id: "b", label: "Agent B", run_id: "run-b" }])
  vi.mocked(jcodeModelsApi.catalog).mockResolvedValue({ choices, bindings: { a: "native-a", b: "native-b" } })
  vi.mocked(jcodeModelsApi.change).mockImplementation(async runs => Object.keys(runs).map(tab_id => ({ tab_id, label: "Duplicate name", error: tab_id === "b" ? "Model unavailable" : null })))
})
afterEach(cleanup)

async function chooseApiRoute() {
  await waitFor(() => expect((screen.getByRole("combobox", { name: "Model and provider" }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole("combobox", { name: "Model and provider" }))
  const option = await screen.findByRole("option", { name: "same-model · API provider · openai-api-key" })
  fireEvent.pointerDown(option, { pointerType: "mouse" })
  fireEvent.click(option)
}

it("keeps native model/provider/reasoning choices together for individual and all jcodes", async () => {
  render(<JcodeModelsDialog />)
  const boxes = await screen.findAllByRole("checkbox")
  expect(screen.queryByRole("textbox", { name: "Model ID" })).toBeNull()
  fireEvent.click(boxes[0])
  await waitFor(() => expect(jcodeModelsApi.catalog).toHaveBeenCalledWith({ a: "run-a" }, expect.any(AbortSignal)))
  await chooseApiRoute()
  expect(screen.getByRole("combobox", { name: "Reasoning level" }).textContent).toContain("API Max")
  fireEvent.click(screen.getByRole("combobox", { name: "Reasoning level" }))
  expect(screen.queryByRole("option", { name: "OAuth High" })).toBeNull()
  const level = await screen.findByRole("option", { name: "API Low" })
  fireEvent.pointerDown(level, { pointerType: "mouse" })
  fireEvent.click(level)
  fireEvent.click(screen.getByRole("button", { name: "Change 1 jcode" }))
  await waitFor(() => expect(jcodeModelsApi.change).toHaveBeenCalledWith({ a: "run-a" }, { a: "native-a", b: "native-b" }, "native-api", "future-low"))
  await screen.findByText("1 applied, 0 failed or partial.")
  fireEvent.click(screen.getByRole("button", { name: "Select all running jcodes" }))
  expect((screen.getByRole("button", { name: "Change 2 jcodes" }) as HTMLButtonElement).disabled).toBe(true)
  await chooseApiRoute()
  fireEvent.click(screen.getByRole("button", { name: "Change 2 jcodes" }))
  await waitFor(() => expect(jcodeModelsApi.change).toHaveBeenLastCalledWith({ a: "run-a", b: "run-b" }, { a: "native-a", b: "native-b" }, "native-api", "future-max"))
  await screen.findByText("1 applied, 1 failed or partial.")
  expect(screen.getByText(/Model unavailable/).closest("p")?.textContent).toContain("b")
})

it("cannot submit an empty selection and reports an unavailable backend", async () => {
  vi.mocked(jcodeModelsApi.targets).mockRejectedValue(new Error("Engine unavailable"))
  render(<JcodeModelsDialog />)
  expect((screen.getByRole("button", { name: "Change 0 jcodes" }) as HTMLButtonElement).disabled).toBe(true)
  await screen.findByRole("alert")
  expect(screen.getByText(/Engine unavailable/)).toBeTruthy()
  expect(jcodeModelsApi.change).not.toHaveBeenCalled()
})

it("fails closed when jcode cannot supply its native choices", async () => {
  vi.mocked(jcodeModelsApi.catalog).mockRejectedValue(new Error("Update jcode and reload the client"))
  render(<JcodeModelsDialog />)
  fireEvent.click((await screen.findAllByRole("checkbox"))[0])
  await screen.findByText(/Update jcode/)
  expect((screen.getByRole("combobox", { name: "Model and provider" }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole("button", { name: "Change 1 jcode" }) as HTMLButtonElement).disabled).toBe(true)
  expect(jcodeModelsApi.change).not.toHaveBeenCalled()
})
