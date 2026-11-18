/**
 * Erase everything as one barrier over org and direct storage and their sign-ins.
 *
 * - One erase at a time: pressing Erase again while one runs joins it (the same promise), so
 *   only the erase that closed the barrier reopens it, and only after its wipe has settled.
 * - `eraseEpoch()` moves when an erase starts. An operation that captured an older epoch and
 *   awaited across an erase must not commit anything afterwards; `erasing()` refuses new ones.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/lib/erasure.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/settingsStore.ts
 * ├── src/push/pushWiring.ts
 * ├── src/screens/machines/DirectCheck.tsx
 * ├── src/screens/machines/MachineRoutes.tsx
 * └── src/screens/onboarding/ConfirmOrg.tsx
 * <module-headers:end>
 */

let epoch = 0;
let running: Promise<void> | null = null;

export function eraseEpoch(): number {
  return epoch;
}

export function erasing(): boolean {
  return running !== null;
}

/** Runs `job` as the erase, or joins the one already running. */
export function runErase(job: () => Promise<void>): Promise<void> {
  if (running) return running;
  epoch += 1;
  const run = (async () => {
    try {
      await job();
    } finally {
      running = null;
    }
  })();
  running = run;
  return run;
}
