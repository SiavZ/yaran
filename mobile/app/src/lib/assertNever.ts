/**
 * Compile-time exhaustiveness for unions that cross a trust or state boundary.
 *
 * - Throws if reached at runtime, naming the unexpected value.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/lib/assertNever.ts
 * ├── src/lib/api.ts
 * ├── src/lib/route.ts
 * ├── src/screens/machines/MachineRow.tsx
 * └── src/screens/onboarding/SignInResult.tsx
 * <module-headers:end>
 */
export function assertNever(value: never): never {
  throw new Error(`unhandled variant ${JSON.stringify(value)}`);
}
