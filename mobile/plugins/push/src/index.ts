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
 * ├── @yaran/mobile-shell:src/continuations.test.tsx
 * ├── @yaran/mobile-shell:src/explicitOpen.test.tsx
 * ├── @yaran/mobile-shell:src/intakeBoundaries.test.tsx
 * ├── @yaran/mobile-shell:src/push/NotificationSettingsSection.tsx
 * ├── @yaran/mobile-shell:src/push/muteSync.ts
 * ├── @yaran/mobile-shell:src/push/notificationTap.ts
 * ├── @yaran/mobile-shell:src/push/pushDeps.ts
 * ├── @yaran/mobile-shell:src/push/pushPermission.ts
 * ├── @yaran/mobile-shell:src/push/pushRaces.test.ts
 * ├── @yaran/mobile-shell:src/push/pushRegistration.ts
 * ├── @yaran/mobile-shell:src/push/pushRejections.test.ts
 * ├── @yaran/mobile-shell:src/push/pushTestKit.ts
 * ├── @yaran/mobile-shell:src/push/pushToggles.test.ts
 * ├── @yaran/mobile-shell:src/push/pushTurns.test.ts
 * ├── @yaran/mobile-shell:src/push/pushWiring.test.ts
 * ├── @yaran/mobile-shell:src/push/pushWiring.ts
 * ├── @yaran/mobile-shell:src/reopenPriority.test.tsx
 * ├── @yaran/mobile-shell:src/screens/settings/NotificationSettings.tsx
 * └── @yaran/mobile-shell:src/screens/settings/notificationPreferences.test.tsx
 * <module-headers:end>
 */
import { registerPlugin } from "@capacitor/core";
import type { PushPlugin } from "./definitions.ts";

export const Push = registerPlugin<PushPlugin>("Push", {
  web: () => import("./web.ts").then((m) => new m.PushWeb()),
});

export type * from "./definitions.ts";
export * from "./guards.ts";
