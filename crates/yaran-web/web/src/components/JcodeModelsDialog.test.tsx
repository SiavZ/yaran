// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

vi.mock("@/lib/store", () => ({
  useYaran: () => ({ jcodeModelsOpen: true }),
  closeJcodeModels: vi.fn(),
}))
vi.mock("@/lib/jcodeModelsApi", () => ({
  jcodeModelsApi: { targets: vi.fn(), change: vi.fn() },
}))

import { JcodeModelsDialog } from "./JcodeModelsDialog"
import { jcodeModelsApi } from "@/lib/jcodeModelsApi"

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(jcodeModelsApi.targets).mockResolvedValue([
    { tab_id: "a", label: "Agent A" }, { tab_id: "b", label: "Agent B" },
  ])
  vi.mocked(jcodeModelsApi.change).mockImplementation(async ids => ids.map(tab_id => ({ tab_id, label: tab_id, error: tab_id === "b" ? "Model unavailable" : null })))
})
afterEach(cleanup)

it("switches selected jcodes, supports select-all, and shows partial failures", async () => {
  render(<JcodeModelsDialog />)
  const boxes = await screen.findAllByRole("checkbox")
  fireEvent.change(screen.getByRole("textbox", { name: "Model ID" }), { target: { value: "my-model" } })
  fireEvent.click(boxes[0])
  fireEvent.click(screen.getByRole("button", { name: "Change 1 jcode" }))
  await waitFor(() => expect(jcodeModelsApi.change).toHaveBeenCalledWith(["a"], "my-model"))
  await screen.findByText("1 changed, 0 failed.")
  fireEvent.click(screen.getByRole("button", { name: "Select all running jcodes" }))
  fireEvent.click(screen.getByRole("button", { name: "Change 2 jcodes" }))
  await waitFor(() => expect(jcodeModelsApi.change).toHaveBeenLastCalledWith(["a", "b"], "my-model"))
  await screen.findByText("1 changed, 1 failed.")
  expect(screen.getByText(/Model unavailable/)).toBeTruthy()
})

it("cannot submit an empty selection and reports an unavailable backend", async () => {
  vi.mocked(jcodeModelsApi.targets).mockRejectedValue(new Error("Engine unavailable"))
  render(<JcodeModelsDialog />)
  expect((screen.getByRole("button", { name: "Change 0 jcodes" }) as HTMLButtonElement).disabled).toBe(true)
  await screen.findByRole("alert")
  expect(screen.getByText(/Engine unavailable/)).toBeTruthy()
  expect(jcodeModelsApi.change).not.toHaveBeenCalled()
})
