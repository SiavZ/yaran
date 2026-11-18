// Client half of the per-PTY size-holder model mirrored from the server's
// `PtySizeOwners`. Every attached page may type; the "owner" is only the page
// whose grid the PTY has, the one that typed last. Every other page renders
// that grid scaled to fit, and every handover arrives as a `pty.owner`
// broadcast carrying the holder's connection id.

// A foregrounded tab on an unowned row claims the size on attach by sending
// it; a backgrounded one attaches silently. Read at call time, and foreground when there is no
// `document`, so a claim is never silently suppressed.
export function isForeground(): boolean {
  return typeof document === "undefined"
    ? true
    : document.visibilityState === "visible"
}

/// What the `connected` handshake said about who holds this pty's size:
/// a connection id, `null` for "nobody", or `undefined` for a server that does
/// not answer the question (the key was absent).
export type HandshakeOwner = string | null | undefined

// Seed the size-holder verdict from the server's `connected` answer. A resize
// from a page that does not hold the size is only recorded, so the foreground
// guess alone would leave this page fitting a grid the pty never took; it
// survives only for an unowned pty. The rule order is the contract:
//   1. A superseded handshake keeps the prior verdict. Handshake and `pty.owner`
//      ride different sockets with no ordering between them, and the stale-null
//      direction emits no correcting event.
//   2. An absent owner key is an old server that grants any claim: use foreground.
//   3. `null` is nobody holding the size: foreground decides, and only here.
//   4. Otherwise compare ids; anything but our own renders the holder's grid.
export function seedVerdictFromConnected(input: {
  owner: HandshakeOwner
  myConnId: string
  foreground: boolean
  /// The `owner_epoch` stamped on the `connected` frame; undefined on an old
  /// server (which then omitted `owner` too).
  handshakeEpoch?: number
  /// The newest `pty.owner` epoch already applied for this pty (the client's
  /// per-pty dedup high-water mark); undefined when none has been applied.
  appliedEpoch?: number
  /// The verdict standing when the handshake landed, returned unchanged when
  /// the handshake is superseded by a newer applied `pty.owner`.
  priorVerdict?: boolean
}): boolean {
  if (handshakeSuperseded(input.handshakeEpoch, input.appliedEpoch)) {
    return input.priorVerdict ?? false
  }
  if (input.owner === undefined) return input.foreground
  if (input.owner === null) return input.foreground
  return input.owner === input.myConnId
}

// Whether a `connected` handshake's owner snapshot was overtaken by an already
// applied `pty.owner`: true only when both epochs are known and the applied one
// is strictly newer, so equal epochs and a missing epoch on either side both
// seed normally. The one implementation of the comparison, so the verdict seed
// and the ownership machine's row confirmation cannot drift.
export function handshakeSuperseded(
  handshakeEpoch: number | undefined,
  appliedEpoch: number | undefined,
): boolean {
  return (
    typeof handshakeEpoch === "number" &&
    typeof appliedEpoch === "number" &&
    appliedEpoch > handshakeEpoch
  )
}

// Ownership after a `pty.owner` handover, by id and never by timing: a guess at
// whether the event is our own claim echoing back inverts when two devices claim
// at once and broadcast order flips. A missing id on either side means "not us",
// so a client observes rather than wrongly assuming control.
export function isOwnerAfterHandover(
  eventOwnerId: string | undefined,
  myConnId: string | null,
): boolean {
  return myConnId !== null && eventOwnerId === myConnId
}

// `pty.owner` fan-out: the store's `/ws/events` handler calls `notifyPtyOwner`
// and each mounted terminal view listens for its own pty id. Kept out of the
// store so the view depends on a leaf module, as `ptySocket.ts` does.
type PtyOwnerListener = (ptyId: string, ownerId: string | undefined) => void
const ptyOwnerListeners = new Set<PtyOwnerListener>()

export function onPtyOwner(cb: PtyOwnerListener): () => void {
  ptyOwnerListeners.add(cb)
  return () => {
    ptyOwnerListeners.delete(cb)
  }
}

// The highest `pty.owner` epoch already applied per pty id. The server assigns
// the epoch under its owners lock but broadcasts after releasing it, so epoch
// order is the true claim order and arrival order is not; dropping anything not
// strictly newer converges every client on the latest claim.
const lastEpochByPty = new Map<string, number>()

// Reset the per-pty epoch high-water marks, called on every events reconnect:
// the server's counter restarts at zero on a process restart, and a client
// holding a high mark would ignore every post-restart handover as stale.
// It clears these marks and nothing else. Firing on reconnects that follow no
// restart is safe only for this state, where a forgotten mark can merely accept
// a handover; state that must survive a dropped socket lives in `serverRun.ts`.
export function resetPtyOwnerEpochs(): void {
  lastEpochByPty.clear()
}

// The newest `pty.owner` epoch already applied for `ptyId`, or undefined when
// none has been. Read by the handshake seed to tell a stale `connected` owner
// snapshot from a fresh one; see `seedVerdictFromConnected` rule 2.
export function appliedPtyOwnerEpoch(ptyId: string): number | undefined {
  return lastEpochByPty.get(ptyId)
}

export function notifyPtyOwner(
  ptyId: string,
  ownerId: string | undefined,
  epoch?: number,
): void {
  // An absent epoch (older server, or a non-`pty.owner` caller) is always
  // delivered and never recorded, so mixed versions degrade to last-arrival
  // ordering rather than silently dropping events.
  if (typeof epoch === "number") {
    const last = lastEpochByPty.get(ptyId)
    if (last !== undefined && epoch <= last) return
    lastEpochByPty.set(ptyId, epoch)
  }
  // Snapshot so a listener that unsubscribes during dispatch can't perturb the
  // live iteration.
  for (const cb of [...ptyOwnerListeners]) cb(ptyId, ownerId)
}
