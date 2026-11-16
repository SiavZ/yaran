/**
 * Sanitizer parity with `sanitize.rs::for_terminal` through the shared fixture, and the
 * logger's redaction and escaping.
 *
 * <module-headers:begin>
 * Uses:
 * test/sanitize.test.ts
 * ├── cloud/protocol/fixtures/sanitize_cross_language.json
 * ├── src/log/logger.ts
 * └── src/security/sanitize.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import fixture from "@yaran/protocol/fixtures/sanitize_cross_language.json";
import { describe, expect, it, vi } from "vitest";
import { createLogger, REDACTED, REDACTED_KEYS, scrub } from "../src/log/logger.ts";
import { forTerminal, truncate } from "../src/security/sanitize.ts";

describe("forTerminal", () => {
  it.each(fixture.cases)("$name", ({ input, output }) => expect(forTerminal(input)).toBe(output));
  it("truncates after sanitizing, by code point", () => {
    expect(truncate("\u001babcdef", 5)).toBe("\\x1b…");
    expect(truncate("🚀🚀🚀", 2)).toBe("🚀…");
    expect(truncate("ok", 5)).toBe("ok");
  });
});

describe("logger", () => {
  it("redacts deny-listed keys at any depth, case-insensitively", () => {
    const out = scrub({ a: { Token: "t", list: [{ cookie: "c", p256dh: "p" }], deeper: { code_verifier: "v", ok: 1 } }, Authorization: "Bearer x" });
    expect(out).toEqual({ a: { Token: REDACTED, list: [{ cookie: REDACTED, p256dh: REDACTED }], deeper: { code_verifier: REDACTED, ok: 1 } }, Authorization: REDACTED });
    for (const k of ["token", "jwt", "cookie", "authorization", "signature", "secret", "private_key", "endpoint", "p256dh", "auth", "code", "code_verifier", "state"]) {
      expect(REDACTED_KEYS.has(k)).toBe(true);
    }
  });
  it("emits one JSON object per line with escaped ANSI, OSC and C1 in values and keys", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    createLogger({ request_id: "r1" }).with({ route: "/x" }).warn("thing", { msg: "\u001b]0;pwn\u0007\u009b2J", "\u001bk": 1, err: new Error("boom\u001b[2J") });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]![0]);
    expect([...line].some((c) => c !== "\n" && c !== "\t" && /\p{Cc}/u.test(c))).toBe(false);
    const parsed = JSON.parse(line) as Record<string, string>;
    expect(parsed).toMatchObject({ level: "warn", event: "thing", request_id: "r1", route: "/x", msg: "\\x1b]0;pwn\\x07\\x9b2J", "\\x1bk": 1 });
    expect(parsed.err).toContain("boom\\x1b[2J");
    spy.mockRestore();
  });
});
