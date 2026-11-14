// Turns a failed response's body into the message a toast may carry. A login page
// (Cloudflare Access in front of a cloud hostname, or any proxy) must never become a
// toast full of HTML, and no body may run on for kilobytes. Pure.

/// How much of a plain error body a message keeps, in code points.
export const ERROR_BODY_MAX_CHARS = 300

/// Whether a body is a web page rather than a yaran reply.
export function isHtmlBody(contentType: string, body: string): boolean {
  return /text\/html/i.test(contentType) || body.trimStart().startsWith("<")
}

/// The message for a failed response, or null when the body says nothing. Cut by
/// code point, never by UTF-16 unit, so an emoji at the boundary is kept whole or
/// dropped whole.
export function describeErrorBody(
  status: number,
  contentType: string,
  body: string,
): string | null {
  const text = body.trim()
  if (text === "") return null
  if (isHtmlBody(contentType, text)) {
    return `The server answered HTTP ${status} with a web page instead of a yaran reply. If you reach this machine through Cloudflare Access, your sign-in may have expired.`
  }
  const chars = Array.from(text)
  return chars.length <= ERROR_BODY_MAX_CHARS
    ? text
    : `${chars.slice(0, ERROR_BODY_MAX_CHARS - 1).join("")}…`
}
