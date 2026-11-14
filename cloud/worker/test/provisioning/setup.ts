/**
 * Suite setup: after every test, scan every table of every test world's D1 for the API token,
 * any tunnel token the fake issued and any tunnel secret (acceptance: tokens never persisted).
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/setup.ts
 * └── test/provisioning/helpers/world.ts
 * External: vitest
 *
 * Used by: entry point (vitest setupFiles, from cloud/worker/vitest.provisioning.config.ts)
 * <module-headers:end>
 */
import { afterEach } from "vitest";
import { drainWorlds, expectNoSecretsInD1 } from "./helpers/world.ts";

afterEach(() => {
  for (const w of drainWorlds()) expectNoSecretsInD1(w);
});
