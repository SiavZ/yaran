// Every attached page types into a shared PTY; one of them holds its SIZE: the
// page that typed last, whose natural grid the PTY has. This machine tracks
// whether that page is this one.
//
//   holder      this pane fits its own viewport, and its resizes are applied.
//   not holder  this pane renders the holder's grid, scaled to fit, and its
//               resizes are only recorded, to be applied when it types.
//
// Handshakes and `pty.owner` events are authoritative. Typing never waits on
// this: the server moves the size to whoever types and broadcasts it. The
// verdict channel updates the synchronous gates and React state together.
import { useEffect, useMemo, useRef, useState } from "react"

import {
  appliedPtyOwnerEpoch,
  handshakeSuperseded,
  isForeground,
  isOwnerAfterHandover,
  onPtyOwner,
  seedVerdictFromConnected,
  type HandshakeOwner,
} from "@/lib/ptyOwnership"
import type { ConnState } from "@/lib/types"

import type { ConnectionIdentity, OwnershipVerdict } from "./channels"

export type TerminalOwnershipDeps = {
  /// The pty id: the session id for an agent, the terminal id for a companion.
  id: string
}

export type TerminalOwnership = {
  /// The rendered verdict: whether this page holds the pty's size.
  isOwner: boolean
  /// The verdict channel, for the lifecycle's stable closures.
  ownership: OwnershipVerdict
  /// This socket's connection id, owned by the lifecycle's attach wiring and
  /// read here for the handover comparison.
  connId: ConnectionIdentity
  /// Re-seed the verdict from the `connected` handshake. `ownerEpoch` is the
  /// handshake's `owner_epoch`, which lets the seed defer to a strictly newer
  /// `pty.owner` already applied; undefined on a server that sends none.
  seedFromConnected: (
    myConnId: string,
    owner: HandshakeOwner,
    ownerEpoch?: number,
  ) => void
  /// Whether the server has named this pane's own driver id as the row's size
  /// holder on the current connection: the handshake or a `pty.owner` event.
  /// Until then a holder verdict over an unclaimed row is only the foreground
  /// guess, which a pane off screen must not act on.
  rowConfirmed: boolean
  readRowConfirmed: () => boolean
  /// Whether this socket has given up for good.
  connectionLost: boolean
  /// Feed the PTY socket connection state in. Owns the LOST state.
  notePtyConn: (state: ConnState) => void
}

export function useTerminalOwnership(
  deps: TerminalOwnershipDeps,
): TerminalOwnership {
  const { id } = deps

  // The foreground guess lasts only until the server's connected handshake.
  // No-document contexts count as foreground so a claim is never suppressed.
  const [isOwner, setIsOwner] = useState(isForeground)
  const isOwnerRef = useRef(isOwner)
  const ownership = useMemo<OwnershipVerdict>(
    () => ({
      read: () => isOwnerRef.current,
      write: (mine) => {
        isOwnerRef.current = mine
        setIsOwner(mine)
      },
    }),
    [],
  )

  const myConnIdRef = useRef<string | null>(null)
  const [rowConfirmed, setRowConfirmedState] = useState(false)
  const rowConfirmedRef = useRef(false)
  const setRowConfirmed = (confirmed: boolean) => {
    rowConfirmedRef.current = confirmed
    setRowConfirmedState(confirmed)
  }
  const connId = useMemo<ConnectionIdentity>(
    () => ({
      read: () => myConnIdRef.current,
      write: (next) => {
        // A new connection has not been named the row's holder yet.
        if (next !== myConnIdRef.current) {
          rowConfirmedRef.current = false
          setRowConfirmedState(false)
        }
        myConnIdRef.current = next
      },
    }),
    [],
  )
  // The owner the newest applied `pty.owner` named, or null when it freed the
  // row. A pane whose handshake is still in flight has no id to compare an
  // event with, so the comparison is made again when the handshake lands.
  const newestEventOwnerRef = useRef<string | null>(null)

  // True once this PTY socket has EXHAUSTED its reconnect budget and emitted
  // `failed`. Distinct from "still retrying": this is a hard stop that surfaces
  // an explicit Reconnect affordance.
  const [connectionLost, setConnectionLost] = useState(false)

  // A `pty.owner` event names the new size holder, or marks the row unowned.
  useEffect(() => {
    return onPtyOwner((ptyId, ownerId) => {
      if (ptyId !== id) return
      newestEventOwnerRef.current = ownerId ?? null
      const mine = isOwnerAfterHandover(ownerId, myConnIdRef.current)
      setRowConfirmed(mine)
      ownership.write(mine)
    })
  }, [id, ownership])

  // The connected handshake replaces the foreground guess. It can be stale,
  // riding the PTY socket while `pty.owner` rides the events socket with
  // nothing ordering the two, so a strictly newer applied `pty.owner` wins.
  function seedFromConnected(
    myConnId: string,
    owner: HandshakeOwner,
    ownerEpoch?: number,
  ) {
    const appliedEpoch = appliedPtyOwnerEpoch(id)
    const superseded = handshakeSuperseded(ownerEpoch, appliedEpoch)
    if (!superseded) {
      // An old server that does not answer grants any claim, as it always has.
      setRowConfirmed(owner === undefined || owner === myConnId)
    }
    // The page's other pane took the size on the driver id this socket was
    // just seated on, and that event reached this pane before its own
    // handshake, which was snapshotted before it.
    const eventNamedThisSeat =
      superseded && newestEventOwnerRef.current === myConnId
    if (eventNamedThisSeat) setRowConfirmed(true)
    const mine =
      eventNamedThisSeat ||
      seedVerdictFromConnected({
        owner,
        myConnId,
        foreground: isForeground(),
        handshakeEpoch: ownerEpoch,
        appliedEpoch,
        priorVerdict: ownership.read(),
      })
    ownership.write(mine)
  }

  /// The PTY socket's own connection state, delivered by the lifecycle.
  /// `failed` is the hard stop that means LOST, cleared by any retry or reopen.
  function notePtyConn(state: ConnState) {
    if (state === "failed") setConnectionLost(true)
    else if (state === "connecting" || state === "open") setConnectionLost(false)
  }

  return {
    isOwner,
    ownership,
    connId,
    seedFromConnected,
    rowConfirmed,
    readRowConfirmed: () => rowConfirmedRef.current,
    connectionLost,
    notePtyConn,
  }
}
