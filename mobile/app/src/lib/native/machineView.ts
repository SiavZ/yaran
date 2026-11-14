/**
 * The shell's one import point for Phase 15's `@yaran/machine-view` plugin.
 *
 * Re-exports the `MachineView` and `Session` plugin objects and their contract types, so
 * screens import from here and tests mock this one module (`src/test/setup.ts`).
 *
 * - Trust boundary (D22): no method returns a JWT, cookie or key. Every Worker call,
 *   `/v1/meta` included, goes through native code; the shell never touches the network.
 * - `orgId` is the org's canonical 02 `OrgUrl`.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/native/machineView.ts
 * └── @yaran/machine-view:src/index.ts
 * External: none
 *
 * Used by:
 * src/lib/native/machineView.ts
 * ├── src/App.tsx
 * ├── src/a11y.test.tsx
 * ├── src/lib/api.test.ts
 * ├── src/lib/api.ts
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/lifecycle.test.ts
 * ├── src/lib/machinesStore.test.ts
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgStore.test.ts
 * ├── src/lib/orgStore.ts
 * ├── src/push/pushDeps.ts
 * ├── src/push/pushRegistration.ts
 * ├── src/push/pushWiring.test.ts
 * ├── src/push/pushWiring.ts
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/machines/machines.test.tsx
 * ├── src/screens/onboarding/ConfirmOrg.tsx
 * ├── src/screens/onboarding/SignInResult.tsx
 * ├── src/screens/onboarding/onboarding.test.tsx
 * ├── src/screens/screens.test.tsx
 * └── src/test/setup.ts
 * <module-headers:end>
 */
export { MachineView, Session } from '@yaran/machine-view';
export type {
  ApiResult,
  CallbackMode,
  ClosedEvent,
  ClosedReason,
  MachineViewPlugin,
  OpenOptions,
  RefusedReason,
  SessionPlugin,
  SignInOutcome,
} from '@yaran/machine-view';
