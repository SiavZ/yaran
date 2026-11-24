import { apiFetch } from "./apiFetch"

export interface ModelTarget {
  tab_id: string
  label: string
  run_id: string
}

export interface ModelChange {
  tab_id: string
  label: string
  error: string | null
}

export interface ModelChoice {
  id: string
  name: string
  provider: string
  api_method: string
  available: boolean
  detail: string
  reasoning_effort: string | null
  reasoning_levels: { value: string; label: string }[]
}

async function response<T>(request: Promise<Response>): Promise<T> {
  const result = await request
  if (!result.ok) throw new Error(await result.text())
  return result.json() as Promise<T>
}

export const jcodeModelsApi = {
  targets: (signal?: AbortSignal) => response<ModelTarget[]>(apiFetch("/api/v1/jcode/models", { signal })),
  catalog: (runs: Record<string, string>, signal?: AbortSignal) => response<ModelChoice[]>(apiFetch("/api/v1/jcode/models/catalog", {
    method: "POST", signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runs }),
  })),
  change: (runs: Record<string, string>, choice_id: string, reasoning_effort: string | null) => response<ModelChange[]>(apiFetch("/api/v1/jcode/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runs, choice_id, reasoning_effort }),
  })),
}
