// "Copy phone link": a verified https link that opens one agent (or one of its
// tabs) in the yaran phone app, on a phone that already has this machine.
//
// The server answers WHERE the link points (the publisher domain the app verifies
// links on, and this machine as an org machine or a direct one); the link itself
// is built here with the shared `agentLinkUrl`, synchronously inside the click,
// because the browser lets a page write the clipboard only within the gesture and
// a fetch would outlive it. So the target is fetched when a menu that offers the
// item renders and kept for a while once known. It is forgotten when the cloud
// pairing or the config changes (`cloud.changed`, `config.changed`: the machine
// may now belong to another org, or the publisher domain moved), after
// TARGET_TTL_MS, and after a refusal; an answer to a question asked before such a
// change is dropped, so a copy never uses the old machine's link. A reconnect
// forgets it at once and asks nothing until the page knows which yaran it is
// talking to (`pausePhoneLinkTarget` / `resumePhoneLinkTarget`): an event missed
// while offline may have been the re-pair.
// When there is no domain the item explains why in a toast and copies nothing: a
// link the app would not open is worse than none. Nothing here is a credential.

import { useEffect, useSyncExternalStore } from "react"
import { agentLinkUrl } from "@yaran/protocol/uri"

import { copyToClipboard } from "./clipboard"
import { notifyInfo, notifySuccess, notifyWarning } from "./notify"
import { chip, prose } from "./prose"
import { phoneApi, type PhoneLinkTarget } from "./phoneApi"

export type PhoneLinkState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; target: PhoneLinkTarget; at: number }
  | { phase: "refused"; message: string }

/** How long a known target is trusted with no change event, as a safety net. */
export const TARGET_TTL_MS = 10 * 60_000

let state: PhoneLinkState = { phase: "idle" }
// Bumped by every invalidation; an answer carries the generation it was asked in.
let generation = 0
// From a reconnect's start until its identity check lets the page recover: no question goes out.
let paused = false
const listeners = new Set<() => void>()

const fresh = (s: PhoneLinkState): s is Extract<PhoneLinkState, { phase: "ready" }> =>
  s.phase === "ready" && Date.now() - s.at < TARGET_TTL_MS

function set(next: PhoneLinkState): void {
  state = next
  for (const l of listeners) l()
}

/** Ask the server, unless a fresh target is known or a question is already out. */
export function loadPhoneLinkTarget(): void {
  if (paused || fresh(state) || state.phase === "loading") return
  const asked = generation
  set({ phase: "loading" })
  phoneApi.linkTarget().then(
    (target) => asked === generation && set({ phase: "ready", target, at: Date.now() }),
    (e: unknown) =>
      asked === generation &&
      set({
        phase: "refused",
        message: e instanceof Error ? e.message : "Could not ask the server for a phone link.",
      }),
  )
}

/** The pairing or the config changed: forget the target, drop answers already on their way,
 *  and ask again at once when a menu that offers the item is showing. */
export function invalidatePhoneLinkTarget(): void {
  generation += 1
  set({ phase: "idle" })
  if (listeners.size > 0) loadPhoneLinkTarget()
}

/** The current answer, loading it on first use. */
export function usePhoneLinkTarget(): PhoneLinkState {
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
  useEffect(() => loadPhoneLinkTarget(), [])
  return current
}

/** The link for `agentId` (and `tabId`, absent for the agent's first tab), or null
 *  when the target is not known or the ids cannot go in a link. */
export function phoneLinkFor(
  link: PhoneLinkState,
  agentId: string,
  tabId?: string,
): string | null {
  if (!fresh(link)) return null
  try {
    return agentLinkUrl(link.target.publisher_domain, {
      target: link.target.target,
      agentId,
      ...(tabId === undefined ? {} : { tabId }),
    })
  } catch {
    return null
  }
}

/** The menu item's action: copy within the gesture, and say what happened. */
export function copyPhoneLink(link: PhoneLinkState, agentId: string, tabId?: string): void {
  if (link.phase === "refused") {
    notifyWarning(link.message)
    // Ask again for the next press: the owner may have fixed the cause meanwhile.
    set({ phase: "idle" })
    loadPhoneLinkTarget()
    return
  }
  if (!fresh(link) || link !== state) {
    // Expired, or the page learned something newer since this menu rendered: never copy it.
    if (link.phase === "ready") loadPhoneLinkTarget()
    notifyInfo("Still asking the server where a phone link should point. Try again in a moment.")
    return
  }
  const url = phoneLinkFor(link, agentId, tabId)
  if (url === null) {
    notifyWarning("This agent's id cannot go in a phone link.")
    return
  }
  void copyToClipboard(url).then((copied) =>
    copied
      ? notifySuccess(
          "Copied a phone link. It opens this agent in the yaran app on a phone that has already added this machine.",
        )
      : notifyWarning(prose`The browser would not copy the phone link. Here it is to copy by hand: ${chip(url)}`),
  )
}

/** A reconnect started: forget the target and any answer on its way, and ask nothing until resumed. */
export function pausePhoneLinkTarget(): void {
  paused = true
  invalidatePhoneLinkTarget()
}

/** The reconnect's identity check passed and the page recovers: ask again (if a menu is showing). */
export function resumePhoneLinkTarget(): void {
  paused = false
  invalidatePhoneLinkTarget()
}

/** Tests only: forget the answer. */
export function resetPhoneLinkForTests(): void {
  state = { phase: "idle" }
  generation += 1
  paused = false
}
