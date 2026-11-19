// How many human-board cards wait on the person running this yaran, for the
// phone hub's Tasks for Human button. Their own queue when the board has
// people (`[board] me`), every card otherwise; news waits on nobody.

import { useEffect, useState } from "react"

import { defaultQueue, waitingCount } from "./board"
import { boardApi } from "./boardApi"

// shortcut: re-read while the hub is visible, because nothing on the events
// socket says the board changed; push a board-changed event if this ever costs
// too much.
export const BOARD_WAITING_POLL_MS = 15_000

/** The waiting count, or `null` until the board has been read once (or cannot be). */
export function useBoardWaiting(): number | null {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function tick() {
      if (cancelled || document.hidden) return
      try {
        const view = await boardApi.get()
        if (!cancelled) setCount(waitingCount(view.cards, defaultQueue(view)))
      } catch {
        // A badge raises no toast: the next read recovers, and the dialog says why it cannot read.
      }
      if (!cancelled) timer = setTimeout(tick, BOARD_WAITING_POLL_MS)
    }
    function onVisibility() {
      if (timer !== undefined) clearTimeout(timer)
      if (!document.hidden) void tick()
    }
    document.addEventListener("visibilitychange", onVisibility)
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [])
  return count
}
