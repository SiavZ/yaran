/**
 * The Preferences row for `[cloud] mode`, spread into `SETTING_GROUPS`.
 *
 * Its write target is bespoke (`"cloudMode"`): saving the value is half of it, the other
 * half starts or stops the Cloudflare tunnel, which only the serve loop can do.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/settingsDescriptorsCloud.ts
 * ├── src/lib/bootstrapApi.ts
 * └── src/lib/settingsDescriptors.ts
 * External: none
 *
 * Used by:
 * src/lib/settingsDescriptorsCloud.ts
 * ├── src/lib/settingsDescriptors.ts
 * └── src/lib/settingsDescriptorsCloud.test.ts
 * <module-headers:end>
 */

import type { Bootstrap } from "./bootstrapApi";
import type { SettingDescriptor } from "./settingsDescriptors";

export const CLOUD_MODE_SETTING: SettingDescriptor = {
  key: "cloud.mode",
  label: "Remote access through Yaran Cloud",
  description:
    'Whether yaran runs its Cloudflare tunnel so your phone can reach this machine. "Auto" runs it whenever this machine is paired and yaran is serving. "Yes" does the same and warns when this machine is not paired. "No" never runs it and keeps the pairing. Changing this applies to the tunnel right now, so choosing "No" from a browser that reached yaran through the tunnel closes this tab\'s connection.',
  surface: "both",
  control: {
    kind: "enum",
    options: [
      { value: "auto", label: "Auto" },
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
  },
  default: "auto",
  writeTarget: "cloudMode",
  read: (b: Bootstrap) => b.cloud?.mode ?? "auto",
};
