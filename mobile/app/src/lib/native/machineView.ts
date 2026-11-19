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
 * ├── src/approvalNavigation.test.tsx
 * ├── src/continuations.test.tsx
 * ├── src/explicitOpen.test.tsx
 * ├── src/intakeBoundaries.test.tsx
 * ├── src/launch.test.tsx
 * ├── src/lib/api.test.ts
 * ├── src/lib/api.ts
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/deepLinks.test.ts
 * ├── src/lib/directStore.test.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/heldLinks.test.ts
 * ├── src/lib/lifecycle.test.ts
 * ├── src/lib/lifecycle.ts
 * ├── src/lib/machinesStore.test.ts
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgStore.test.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/share.test.ts
 * ├── src/lib/share.ts
 * ├── src/orgStaging.test.tsx
 * ├── src/orgStagingSettle.test.tsx
 * ├── src/push/muteSync.ts
 * ├── src/push/pushDeps.ts
 * ├── src/push/pushRaces.test.ts
 * ├── src/push/pushRegistration.ts
 * ├── src/push/pushRejections.test.ts
 * ├── src/push/pushToggles.test.ts
 * ├── src/push/pushTurns.test.ts
 * ├── src/push/pushWiring.test.ts
 * ├── src/push/pushWiring.ts
 * ├── src/reopenPriority.test.tsx
 * ├── src/screens/machines/DirectCheck.tsx
 * ├── src/screens/machines/DirectSection.tsx
 * ├── src/screens/machines/InstanceChangedDialog.tsx
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/machines/MachineRoutes.tsx
 * ├── src/screens/machines/ShareTarget.tsx
 * ├── src/screens/machines/approval.test.tsx
 * ├── src/screens/machines/direct.test.tsx
 * ├── src/screens/machines/directText.tsx
 * ├── src/screens/machines/instanceChanged.test.tsx
 * ├── src/screens/machines/machines.test.tsx
 * ├── src/screens/machines/upgradeRequired.test.tsx
 * ├── src/screens/onboarding/ConfirmOrg.tsx
 * ├── src/screens/onboarding/SignInResult.tsx
 * ├── src/screens/onboarding/onboarding.test.tsx
 * ├── src/screens/screens.test.tsx
 * ├── src/screens/settings/notificationPreferences.test.tsx
 * ├── src/shareBatch.test.tsx
 * └── src/test/setup.ts
 * <module-headers:end>
 */
export { MAX_ROUTES, MachineView, Session } from '@yaran/machine-view';
export type {
  ApiResult,
  CallbackMode,
  ClosedEvent,
  ClosedReason,
  DirectSignInOutcome,
  DirectSignOutOutcome,
  DirectStatus,
  MachineRoute,
  MachineViewPlugin,
  OpenOptions,
  RefusedReason,
  SessionPlugin,
  ShareReceivedEvent,
  ShareStatus,
  SignInOutcome,
} from '@yaran/machine-view';
