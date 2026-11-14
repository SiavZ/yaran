/**
 * Per-file test setup: applies the D1 migrations to the file's isolated database and
 * starts Mock Service Worker with a catch-all that fails every unmocked outbound request,
 * so no test can reach a live service.
 *
 * <module-headers:begin>
 * Uses: none
 * External: @msw/cloudflare, cloudflare:test, msw, vitest
 *
 * Used by:
 * test/setup.ts
 * ├── test/access-jwt.test.ts
 * └── test/helpers/access.ts
 * <module-headers:end>
 */
import { setupNetwork } from "@msw/cloudflare";
import { applyD1Migrations, env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

export const network = setupNetwork();

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  network.enable();
});
beforeEach(() => {
  network.use(http.all("*", ({ request }) => {
    console.error(`unmocked outbound request to ${new URL(request.url).host}`);
    return HttpResponse.error();
  }));
});
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());
