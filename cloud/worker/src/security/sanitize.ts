/**
 * Sanitizer for attacker-controlled text before it reaches a log line or an error body.
 *
 * The TypeScript twin of `yaran_core::sanitize::for_terminal`: `\n` and `\t` are kept, and
 * every other control character (C0, DEL, C1, the 8-bit CSI `\x9b`) becomes `\xNN`, so an
 * operator still sees what was filtered and a log line reads the same on both sides.
 * `cloud/protocol/fixtures/sanitize_cross_language.json` pins the two implementations.
 *
 * - Pure; never logs (the logger calls it, so logging here would recurse).
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/security/sanitize.ts
 * ├── src/log/logger.ts
 * ├── src/scheduled/dispatcher.ts
 * └── test/sanitize.test.ts
 * <module-headers:end>
 */

/** Escapes control characters exactly as `sanitize.rs::for_terminal` does. */
export function forTerminal(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\n" || ch === "\t") out += ch;
    else if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return out;
}

/** Sanitizes, then caps at `max` characters (code points), marking a cut with `…`. */
export function truncate(text: string, max: number): string {
  const chars = [...forTerminal(text)];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}
