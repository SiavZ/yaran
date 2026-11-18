// HTTP client for the phone routes that need no pairing code: the direct
// add-machine QR code ("Connect a phone…") and the phone link target ("Copy phone
// link"). A refusal is 409 `{error, message}`; the error carries both, and the
// message is the server's own sentence, shown as plain text.

import type { AgentLinkTarget } from "@yaran/protocol/uri"

import { createJsonRequest } from "./jsonRequest"

/** `GET /api/v1/phone/machine-qr`: the host this page arrived on over HTTPS, the
 *  `yaranapp://add-machine?u=…` payload, and that payload as an SVG QR code. */
export interface MachineQr {
  host: string
  uri: string
  svg: string
}

/** `GET /api/v1/phone/link-target`: what `agentLinkUrl` needs besides the agent.
 *  Public metadata: never a credential, never proof of who opens the link. */
export interface PhoneLinkTarget {
  publisher_domain: string
  target: AgentLinkTarget
}

export class PhoneApiError extends Error {
  readonly status: number
  /** The refusal's code (`not_https`, `no_publisher_domain`, …), or null. */
  readonly code: string | null

  constructor(message: string, status: number, code: string | null) {
    super(message)
    this.name = "PhoneApiError"
    this.status = status
    this.code = code
  }
}

function refusalOf(text: string): { error?: unknown; message?: unknown } | null {
  try {
    const body: unknown = JSON.parse(text)
    return typeof body === "object" && body !== null ? body : null
  } catch {
    return null
  }
}

const request = createJsonRequest((message, status, text) => {
  const body = refusalOf(text)
  return new PhoneApiError(
    typeof body?.message === "string" ? body.message : message,
    status,
    typeof body?.error === "string" ? body.error : null,
  )
})

export const phoneApi = {
  machineQr: () => request<MachineQr>("GET", "/api/v1/phone/machine-qr"),
  linkTarget: () => request<PhoneLinkTarget>("GET", "/api/v1/phone/link-target"),
}
