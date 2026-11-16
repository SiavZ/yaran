/**
 * Tests for the `[cloud] mode` Preferences row.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/settingsDescriptorsCloud.test.ts
 * ├── src/lib/bootstrapApi.ts
 * ├── src/lib/settingsDescriptors.ts
 * └── src/lib/settingsDescriptorsCloud.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npx vitest run in crates/yaran-web/web)
 * <module-headers:end>
 */

import { describe, expect, it } from "vitest";
import type { Bootstrap } from "./bootstrapApi";
import { allSettingDescriptors } from "./settingsDescriptors";
import { CLOUD_MODE_SETTING } from "./settingsDescriptorsCloud";

describe("cloud mode row", () => {
  it("is a tri-state with its own write target", () => {
    expect(CLOUD_MODE_SETTING.writeTarget).toBe("cloudMode");
    expect(CLOUD_MODE_SETTING.control).toEqual({
      kind: "enum",
      options: [
        { value: "auto", label: "Auto" },
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
    });
  });

  it("reads the live mode and falls back to auto for an older server", () => {
    const withCloud = { cloud: { mode: "no" } } as unknown as Bootstrap;
    expect(CLOUD_MODE_SETTING.read(withCloud)).toBe("no");
    expect(CLOUD_MODE_SETTING.read({} as Bootstrap)).toBe("auto");
  });

  it("sits right after the Tailscale row", () => {
    const keys = allSettingDescriptors().map((d) => d.key);
    expect(keys.indexOf("cloud.mode")).toBe(
      keys.indexOf("server.tailscale") + 1,
    );
  });
});
