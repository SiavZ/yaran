/**
 * Toast timing policy shared by every yaran surface that raises toasts.
 *
 * Moved out of the web's `lib/notify.ts` so the phone shell's toasts dismiss on the
 * same severity-graded windows. Pure numbers and one pure function: the raiser that
 * calls sonner stays in each consumer.
 *
 * - Grades a final tone's window off the user's `ui.status_clear_seconds` base.
 * - Keeps a busy toast on its fixed leak-guard ceiling, whatever the base says.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/toast-policy.ts
 * ├── @yaran/mobile-shell:src/lib/notify.test.ts
 * ├── @yaran/mobile-shell:src/lib/notify.ts
 * └── web:src/lib/notify.ts
 * <module-headers:end>
 */

/// Fallback window (seconds) used before the bootstrap document lands, matching
/// the config default for `ui.status_clear_seconds`.
export const DEFAULT_STATUS_CLEAR_SECONDS = 6

/// A warning stays up three times as long as a success. Must stay equal to
/// `WARNING_CLEAR_FACTOR` in `crates/yaran-core/src/statusline.rs`.
export const WARNING_DURATION_FACTOR = 3

/// An error stays up four times as long as a success: it is the tone most likely
/// to arrive while the user is looking somewhere else.
export const ERROR_DURATION_FACTOR = 4

/// Hard ceiling for a busy/loading toast: a leak guard for when no further word
/// arrives at all, not a readability window.
///
/// Must stay comfortably above `yaran_core::statusline::BUSY_TIMEOUT`, the cadence
/// a live server answers on, so the guard firing means the server went quiet.
export const BUSY_TOAST_MAX_MS = 60_000

/// Resolve the sonner `duration` for a notification of `tone`. `null`/`undefined`
/// `statusClearSeconds` is the pre-bootstrap window; a configured `0` disables
/// auto-clear for final tones only, since busy always keeps its leak guard.
export function statusToastDuration(
  tone: string,
  statusClearSeconds: number | null | undefined,
): number {
  if (tone === "busy") return BUSY_TOAST_MAX_MS

  const secs = statusClearSeconds ?? DEFAULT_STATUS_CLEAR_SECONDS
  if (secs <= 0) return Infinity

  const base = secs * 1000
  if (tone === "error") return base * ERROR_DURATION_FACTOR
  if (tone === "warning") return base * WARNING_DURATION_FACTOR
  return base // info / success, and any tone the server adds later
}
