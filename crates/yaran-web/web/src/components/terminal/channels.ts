// The write-back channels: values written from inside the wiring, mid-gesture or
// mid-frame, and read by other machines and by the render.
//
// A read-only setting travels one way and belongs in `liveValues.ts` instead. A
// channel is a one-field box whose type name and doc say WHO writes it, so a
// reader can tell a reported verdict from somebody else's, and it is passed to a
// machine explicitly rather than closed over. Anything added here answers the
// same question first: is it a read-only setting in a write-back costume?

/// A one-field box. `read` is called on the hot paths (every keystroke, every
/// mouse report), so it stays a property read rather than a subscription.
export type Channel<T> = {
  read: () => T
  write: (value: T) => void
}

/// Build a channel over a plain closure variable.
export function channel<T>(initial: T): Channel<T> {
  let value = initial
  return {
    read: () => value,
    write: (next) => {
      value = next
    },
  }
}

/// THE MODIFIER LATCH. The accessory bar's sticky Ctrl/Alt, one-shot.
/// OWNER: the input surface, which writes the visible state and this together.
/// READERS: the key handler and the `onData` transform, which must see a latch
/// armed one keystroke ago, before any re-render could have delivered it.
export type ModifierLatch = Channel<{ ctrl: boolean; alt: boolean }>

/// THE OWNERSHIP VERDICT. Whether THIS page holds the PTY's size: the page
/// that typed last, whose grid the PTY has. It gates no input; every attached
/// page types.
/// OWNER: the ownership machine, writing synchronously at each transition, ahead
/// of the re-render, because the coordinator's next fit is gated on the answer.
/// READERS: the resize coordinator (fit this viewport or render the holder's
/// grid) and the heartbeat.
export type OwnershipVerdict = Channel<boolean>

/// THE CONNECTION IDENTITY. This pane's PTY-socket connection id, or null, which
/// reads safely as "not us".
/// OWNER: the lifecycle's socket handlers.
/// READERS: the ownership machine's handover comparison, and the upload route,
/// which needs the TERMINAL socket's id rather than the events socket's.
export type ConnectionIdentity = Channel<string | null>
