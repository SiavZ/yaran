/**
 * Package entry of @yaran/machine-view: registers the two native plugins with Capacitor.
 *
 * The web fallbacks (`web.ts`) only exist so Vitest and a plain browser load the package;
 * they reject every call with `unavailable`.
 *
 * - Re-exports the contract, the outcome unions and the shell-side machine opener.
 *
 * <module-headers:begin>
 * Uses:
 * src/index.ts
 * ├── src/definitions.ts
 * ├── src/outcomes.ts
 * ├── src/routes.ts
 * └── src/web.ts
 * External: @capacitor/core
 *
 * Used by: entry point (package entry of @yaran/machine-view, the "." export in mobile/plugins/machine-view/package.json)
 * src/index.ts
 * ├── @yaran/mobile-shell:src/lib/native/machineView.ts
 * ├── @yaran/mobile-shell:src/lib/openMachine.test.ts
 * └── @yaran/mobile-shell:src/lib/openMachine.ts
 * <module-headers:end>
 */
import { registerPlugin } from "@capacitor/core";
import type { MachineViewPlugin, SessionPlugin } from "./definitions.ts";

export const MachineView = registerPlugin<MachineViewPlugin>("MachineView", {
  web: () => import("./web.ts").then((m) => new m.MachineViewWeb()),
});

export const Session = registerPlugin<SessionPlugin>("Session", {
  web: () => import("./web.ts").then((m) => new m.SessionWeb()),
});

export type * from "./definitions.ts";
export * from "./outcomes.ts";
export * from "./routes.ts";
