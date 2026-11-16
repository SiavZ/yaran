import { getConnectionId } from "./connection"
import { describeErrorBody, isHtmlBody } from "./httpBody"
import { accessSession } from "./native/accessSession"

type RequestErrorFactory = (
  message: string,
  status: number,
  responseText: string,
) => Error

interface JsonRequestOptions {
  mapSerializationErrors?: boolean
}

function serializeJsonBody(body: unknown): string | undefined {
  return body === undefined ? undefined : JSON.stringify(body)
}

async function responseError(
  response: Response,
  createError: RequestErrorFactory,
): Promise<Error> {
  const detail = (await response.text().catch(() => "")).trim()
  const contentType = response.headers.get("content-type") ?? ""
  // A login page or an Access refusal: ask whether the sign-in is what failed.
  if (
    response.status === 401 ||
    response.status === 403 ||
    isHtmlBody(contentType, detail)
  ) {
    accessSession.noteRequestTrouble()
  }
  const message =
    describeErrorBody(response.status, contentType, detail) ??
    `request failed (${response.status})`
  return createError(message, response.status, detail)
}

// 204 and an empty body are `undefined`, which every `request<void>` caller relies
// on. A body that is not JSON is a failure: it is a login page or a proxy, not yaran.
async function parseJsonResponse<T>(
  response: Response,
  createError: RequestErrorFactory,
): Promise<T> {
  if (response.status === 204) return undefined as T

  const text = await response.text().catch(() => "")
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    accessSession.noteRequestTrouble()
    throw createError(
      `The server sent something yaran could not read (HTTP ${response.status}, not JSON). If you reach this machine through Cloudflare Access, your sign-in may have expired.`,
      response.status,
      "",
    )
  }
}

export function createJsonRequest(
  createError: RequestErrorFactory,
  options: JsonRequestOptions = {},
) {
  const mapSerializationErrors = options.mapSerializationErrors ?? false

  return async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    // Same-origin, so no preflight; it makes Access answer an expired session with
    // 401 rather than a redirect fetch cannot follow.
    const headers: Record<string, string> = {
      "X-Requested-With": "XMLHttpRequest",
    }
    const id = getConnectionId()
    if (id) headers["x-connection-id"] = id

    if (body !== undefined) {
      headers["content-type"] = "application/json"
    }

    let payload: string | undefined
    if (!mapSerializationErrors) payload = serializeJsonBody(body)

    let response: Response
    try {
      if (mapSerializationErrors) payload = serializeJsonBody(body)
      response = await fetch(path, {
        method,
        credentials: "same-origin",
        headers,
        body: payload,
      })
    } catch {
      accessSession.noteRequestTrouble()
      throw createError("Could not reach the server.", 0, "")
    }

    if (!response.ok) throw await responseError(response, createError)
    return parseJsonResponse<T>(response, createError)
  }
}
