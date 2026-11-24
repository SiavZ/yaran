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

async function response<T>(request: Promise<Response>): Promise<T> {
  const result = await request
  if (!result.ok) throw new Error(await result.text())
  return result.json() as Promise<T>
}

export const jcodeModelsApi = {
  targets: (signal?: AbortSignal) => response<ModelTarget[]>(apiFetch("/api/v1/jcode/models", { signal })),
  change: (runs: Record<string, string>, model: string) => response<ModelChange[]>(apiFetch("/api/v1/jcode/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runs, model }),
  })),
}
