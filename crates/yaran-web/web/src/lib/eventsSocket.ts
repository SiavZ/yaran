import { createHeartbeat, type Heartbeat } from "./heartbeat"
import {
  ACCESS_SESSION_EXPIRED_CLOSE,
  accessSession,
} from "./native/accessSession"
import { ReconnectingSocket } from "./reconnectingSocket"
import type { EventsClientMessage, EventsServerMessage } from "./types"

// Must stay at or below the server's own `MAX_EVENT_TOPICS_PER_FRAME`, above which
// it silently rejects an interest frame; the reconnect resend chunks to this size.
const MAX_EVENT_TOPICS_PER_FRAME = 64

// JSON events channel: it tracks subscriptions, resends them in bounded chunks after
// every open, and stays active while hidden so attention events still reach
// notifications. Reconnect timing and lifecycle live in `ReconnectingSocket`.
export class EventsSocket extends ReconnectingSocket {
  // The complete, authoritative interest set. Coarse topics (sessions/projects/
  // config) plus the per-screen fine topics (session:<id>:changes) all live
  // here, so a reconnect can re-send the lot.
  private readonly subscriptions = new Set<string>()

  // Consumer callback. Default is a no-op so the store only wires what it needs.
  onEvent: (ev: EventsServerMessage) => void = () => {}

  // The one periodic client frame, `{"beat":N}`, answered `{"event":"beat","n":N}`.
  // The server's own ping is a control frame JS never sees, so this is the only
  // way to notice a half-open socket; a missed answer drops it for the ordinary
  // retry. Visible time only, and nothing is sent while hidden. Built at the
  // first open rather than at construction, which runs at import.
  private heartbeat: Heartbeat | null = null

  // The current interest set (sorted for deterministic test assertions). Read
  // only. Mutate via subscribe/unsubscribe.
  get topics(): string[] {
    return [...this.subscriptions].sort()
  }

  // Re-send the WHOLE interest set on every (re)open: server-side interest is
  // per-connection and a dropped connection discards it. Chunked so a large set
  // never exceeds the server's per-frame topic cap (which it would silently drop).
  protected onSocketOpen(): void {
    this.heartbeat ??= createHeartbeat({
      send: (n) => this.sendRaw({ beat: n }),
      isOwner: () => false,
      viewed: () => false,
      onStalled: () => this.dropForRetry(),
    })
    this.heartbeat.reset()
    this.heartbeat.start()
    if (this.subscriptions.size > 0) {
      const topics = [...this.subscriptions]
      for (let i = 0; i < topics.length; i += MAX_EVENT_TOPICS_PER_FRAME) {
        this.sendRaw({
          subscribe: topics.slice(i, i + MAX_EVENT_TOPICS_PER_FRAME),
        })
      }
    }
  }

  protected handleMessage(event: MessageEvent): void {
    if (typeof event.data === "string") {
      this.handleText(event.data)
    }
  }

  private handleText(raw: string): void {
    let message: EventsServerMessage
    try {
      message = JSON.parse(raw) as EventsServerMessage
    } catch (err) {
      // Log the length but not the potentially large or sensitive frame body.
      console.warn(
        `[yaran] events socket dropped an unparseable frame (${raw.length} chars)`,
        err,
      )
      return
    }
    if (message.event === "beat") {
      if (typeof message.n === "number") this.heartbeat?.noteAnswer(message.n)
      return
    }
    // Forward resource and control frames as-is; the store dispatches on
    // `event`. Lag catch-up arrives as an ordinary `session.changes` frame.
    if (typeof message.event === "string") {
      this.onEvent(message)
    }
  }

  // Add topics to the interest set and (when open) send only the newly-added
  // ones. The full set is re-sent on the next open, so a subscribe issued while
  // the socket is down is not lost.
  subscribe(topics: string[]): void {
    const added: string[] = []
    for (const topic of topics) {
      if (!this.subscriptions.has(topic)) {
        this.subscriptions.add(topic)
        added.push(topic)
      }
    }
    if (added.length > 0) this.sendRaw({ subscribe: added })
  }

  // Remove topics from the interest set and (when open) tell the server. Removing
  // an unknown topic is a no-op.
  unsubscribe(topics: string[]): void {
    const removed: string[] = []
    for (const topic of topics) {
      if (this.subscriptions.delete(topic)) removed.push(topic)
    }
    if (removed.length > 0) this.sendRaw({ unsubscribe: removed })
  }

  // An expired Access session (Phase 11 closes with 4401) is an ordinary retry,
  // and it asks the access-session probe whether a sign-in is what is needed.
  protected shouldReconnect(closeCode: number): boolean {
    if (closeCode === ACCESS_SESSION_EXPIRED_CLOSE) accessSession.noteSessionExpired()
    return true
  }

  dispose(): void {
    this.heartbeat?.stop()
    super.dispose()
  }

  // Whether the frame went on the wire, so the heartbeat starts no deadline for
  // a beat it never sent.
  private sendRaw(message: EventsClientMessage): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
      return true
    }
    return false
  }
}
