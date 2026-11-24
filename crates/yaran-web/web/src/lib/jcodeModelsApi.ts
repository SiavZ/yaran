import { apiFetch } from "./apiFetch"

export interface ModelTarget {
  tab_id: string
  label: string
}

export interface ModelChange extends ModelTarget {
  error: string | null
}

async function response<T>(request: Promise<Response>): Promise<T> {
  const result = await request
  if (!result.ok) throw new Error(await result.text())
  return result.json() as Promise<T>
}

export const jcodeModelsApi = {
  targets: (signal?: AbortSignal) => response<ModelTarget[]>(apiFetch("/api/v1/jcode/models", { signal })),
  change: (tab_ids: string[], model: string) => response<ModelChange[]>(apiFetch("/api/v1/jcode/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tab_ids, model }),
  })),
}
