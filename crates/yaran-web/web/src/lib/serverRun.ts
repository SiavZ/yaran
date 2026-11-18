// Publishes run-identity probe results to pane state keyed by server counters: a
// replay-generation high-water mark retires whenever the run is not confirmed
// unchanged. Socket admission is a separate policy in `serverValidated.ts`.

/// What the probe said about the run behind this reconnect.
export type ServerRunProbe =
  /// Same build, same process id: nothing to retire.
  | "same"
  /// A different run answered. The page is being reloaded; whatever is read
  /// between now and then must not trust the old run's counters.
  | "changed"
  /// The probe could not say (it failed, or the server does not answer). Not
  /// evidence of a change, but not evidence of sameness either.
  | "unknown"

const unconfirmedListeners = new Set<() => void>()

/// Subscribe to "this run is not confirmed to be the one we started with": a
/// change, or a probe that could not answer. Returns the unsubscribe.
export function onServerRunUnconfirmed(cb: () => void): () => void {
  unconfirmedListeners.add(cb)
  return () => {
    unconfirmedListeners.delete(cb)
  }
}

/// Publish a probe result. Called by the store, from the one place that runs the
/// probe. Snapshots the listener set so a callback that unsubscribes during
/// dispatch cannot perturb the live iteration.
export function noteServerRunProbe(result: ServerRunProbe): void {
  if (result === "same") return
  for (const cb of [...unconfirmedListeners]) cb()
}
