/**
 * Public entry of `@yaran/push`: registers the native `Push` plugin and re-exports its contract
 * and guards.
 *
 * <module-headers:begin>
 * Uses:
 * src/index.ts
 * ├── src/definitions.ts
 * ├── src/guards.ts
 * └── src/web.ts
 * External: @capacitor/core
 *
 * Used by: entry point (package entry of @yaran/push (the "." export in mobile/plugins/push/package.json), imported by the shell)
 * src/index.ts
 * ├── @yaran/mobile-shell:src/push/NotificationSettingsSection.tsx
 * ├── @yaran/mobile-shell:src/push/notificationTap.ts
 * ├── @yaran/mobile-shell:src/push/pushDeps.ts
 * ├── @yaran/mobile-shell:src/push/pushPermission.ts
 * ├── @yaran/mobile-shell:src/push/pushRegistration.ts
 * ├── @yaran/mobile-shell:src/push/pushTestKit.ts
 * ├── @yaran/mobile-shell:src/push/pushWiring.test.ts
 * ├── @yaran/mobile-shell:src/push/pushWiring.ts
 * └── @yaran/mobile-shell:src/screens/settings/NotificationSettings.tsx
 * <module-headers:end>
 */
import { registerPlugin } from "@capacitor/core";
import type { PushPlugin } from "./definitions.ts";

export const Push = registerPlugin<PushPlugin>("Push", {
  web: () => import("./web.ts").then((m) => new m.PushWeb()),
});

export type * from "./definitions.ts";
export * from "./guards.ts";
