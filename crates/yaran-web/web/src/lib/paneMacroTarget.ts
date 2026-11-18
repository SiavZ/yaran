import { createKeyedRegistry } from "./keyedRegistry"

// Where a picked macro goes, keyed by pty id. The Macros controls sit outside the
// pane (the desktop header, the phone flap, the theater pill) and several panes
// can be mounted at once, so each pane publishes its own answer under its own id
// and a control reads the one for the pane it belongs to, never whichever pane
// mounted last.

/// The compose draft, while the compose bar is this pane's typing surface.
export interface ComposeInsertSink {
  /// Inserts raw macro text into the draft at the caret. Newlines stay verbatim;
  /// the compose Send path transforms them.
  insert: (text: string) => void
  /// The compose textarea, so the macro picker can land its close focus in the
  /// draft the macro just joined rather than on its own trigger.
  target: () => HTMLElement | null
}

/// One pane's answer.
export interface PaneMacroTarget {
  /// Writes bytes down this pane's own socket. Returns whether the bytes went
  /// on the wire: false while the socket is reconnecting, when they are dropped.
  send: (bytes: Uint8Array) => boolean
  /// The compose draft, or null while the compose bar is not the typing surface.
  compose: ComposeInsertSink | null
  /// This pane's typing surface, resolved at call time: the compose box while it
  /// is up, otherwise the terminal. The desktop picker returns focus here when it
  /// closes, because the macro was pasted without submitting and the Enter that
  /// submits it must reach this pane, not the trigger and not another pane.
  typingSurface: () => HTMLElement | null
}

const targets = createKeyedRegistry<PaneMacroTarget>()

/**
 * Publish this pane's macro target and return its retirement. Last write wins,
 * and the retirement removes the entry only while it is still this call's, so a
 * replacement pane survives the outgoing pane's late cleanup.
 */
export function registerPaneMacroTarget(
  ptyId: string,
  target: PaneMacroTarget,
): () => void {
  return targets.register(ptyId, target)
}

/// The published target for one pty, or null when no pane for it is mounted.
export function paneMacroTargetFor(ptyId: string): PaneMacroTarget | null {
  return targets.read(ptyId) ?? null
}

/// The same lookup, re-rendering the caller whenever any pane republishes.
export function usePaneMacroTarget(ptyId: string): PaneMacroTarget | null {
  targets.useVersion()
  return paneMacroTargetFor(ptyId)
}

/** Test-only: forget every registration between cases. */
export function resetPaneMacroTargets(): void {
  targets.reset()
}
