/**
 * The push routes' outcome mapping and the W6 route through 04's real pipeline.
 *
 * <module-headers:begin>
 * Uses:
 * test/push/routes.test.ts
 * ├── src/http/responses.ts
 * ├── src/push/routes.ts
 * ├── src/push/store.ts
 * └── test/push/helpers/fakes.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { HttpError } from "../../src/http/responses.ts";
import { purgeEventIds } from "../../src/push/store.ts";
import { respond } from "../../src/push/routes.ts";
import { harness, MACHINE, NOW } from "./helpers/fakes.ts";

describe("respond", () => {
  it("maps json, empty and error outcomes", async () => {
    const ok = respond({ kind: "json", status: 202, body: { accepted: [] } });
    expect([ok.status, await ok.json()]).toEqual([202, { accepted: [] }]);
    expect(respond({ kind: "empty", status: 202 }).status).toBe(202);
    try {
      respond({ kind: "error", code: "rate_limited", message: "slow down", retryAfter: 60 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect([(e as HttpError).code, (e as HttpError).headers["Retry-After"]]).toEqual(["rate_limited", "60"]);
    }
  });
});

describe("purgeEventIds", () => {
  it("deletes only ids past the 24 h window, a bounded slice at a time", async () => {
    const h = await harness();
    for (let i = 0; i < 3; i++) await h.db.prepare("INSERT INTO event_ids (machine_id, id, seen_at) VALUES (?, ?, ?)").bind(MACHINE, `old-${i}`, NOW - 90_000).run();
    await h.db.prepare("INSERT INTO event_ids (machine_id, id, seen_at) VALUES (?, 'new', ?)").bind(MACHINE, NOW).run();
    expect(await purgeEventIds(h.db, NOW, 2)).toBe(2);
    expect(await purgeEventIds(h.db, NOW, 2)).toBe(1);
    expect((await h.db.prepare("SELECT id FROM event_ids").all()).results).toEqual([{ id: "new" }]);
  });
});
