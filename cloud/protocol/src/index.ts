/**
 * Public entry of `@yaran/protocol`: the yaran cloud wire contract as code.
 *
 * Re-exports the generated wire types, the validators, the error registry helpers, the
 * sealed-envelope and signature codecs, the push payload helpers and the URI/UA helpers.
 * Consumers import from "@yaran/protocol" only; deep imports are not part of the contract
 * (the schemas, registries and fixtures are exported as data paths instead). The two
 * exceptions are `@yaran/protocol/ua` and `@yaran/protocol/uri`: dependency-free subpaths
 * for a bundle (the yaran web UI) that must not resolve `jose` or the schema validator.
 *
 * - No side effects at import time beyond building lookup tables.
 *
 * <module-headers:begin>
 * Uses:
 * src/index.ts
 * ├── src/b64url.ts
 * ├── src/consent.ts
 * ├── src/errors.ts
 * ├── src/generated/types.ts
 * ├── src/jwe/ec.ts
 * ├── src/jwe/handoff.ts
 * ├── src/jwe/kdf.ts
 * ├── src/push/apns.ts
 * ├── src/push/payload.ts
 * ├── src/push/topic.ts
 * ├── src/redirect.ts
 * ├── src/sig/canonical.ts
 * ├── src/sig/device.ts
 * ├── src/sig/fingerprint.ts
 * ├── src/sig/sign.ts
 * ├── src/sig/verify.ts
 * ├── src/ua.ts
 * ├── src/uri.ts
 * ├── src/validate.ts
 * └── src/version.ts
 * External: none
 *
 * Used by: entry point (package entry of @yaran/protocol, the "." export in cloud/protocol/package.json)
 * src/index.ts
 * ├── @yaran/machine-view:src/outcomes.ts
 * ├── @yaran/mobile-shell:src/lib/api.ts
 * ├── @yaran/mobile-shell:src/lib/deepLinks.ts
 * ├── @yaran/mobile-shell:src/lib/lifecycle.test.ts
 * ├── @yaran/mobile-shell:src/lib/machinesStore.ts
 * ├── @yaran/mobile-shell:src/lib/openMachine.ts
 * ├── @yaran/mobile-shell:src/lib/protocolCompat.ts
 * ├── @yaran/mobile-shell:src/push/pushRegistration.ts
 * ├── @yaran/mobile-shell:src/push/pushTestKit.ts
 * ├── @yaran/mobile-shell:src/push/pushWiring.test.ts
 * ├── @yaran/mobile-shell:src/push/pushWiring.ts
 * ├── @yaran/mobile-shell:src/screens/machines/MachineList.tsx
 * ├── @yaran/mobile-shell:src/screens/machines/MachineRow.tsx
 * ├── @yaran/mobile-shell:src/screens/machines/RemoveMachineDialog.tsx
 * ├── @yaran/mobile-shell:src/screens/machines/machines.test.tsx
 * ├── @yaran/mobile-shell:src/screens/onboarding/ConfirmOrg.tsx
 * ├── @yaran/mobile-shell:src/screens/onboarding/onboarding.test.tsx
 * ├── @yaran/push:src/definitions.ts
 * ├── @yaran/push:test/guards.test.ts
 * └── @yaran/qr:src/payload.ts
 * <module-headers:end>
 */
export type * from "./generated/types.ts";
export * from "./b64url.ts";
export * from "./consent.ts";
export * from "./errors.ts";
export * from "./jwe/ec.ts";
export * from "./jwe/handoff.ts";
export * from "./jwe/kdf.ts";
export * from "./push/apns.ts";
export * from "./push/payload.ts";
export * from "./push/topic.ts";
export * from "./redirect.ts";
export * from "./sig/canonical.ts";
export * from "./sig/device.ts";
export * from "./sig/fingerprint.ts";
export * from "./sig/sign.ts";
export * from "./sig/verify.ts";
export * from "./ua.ts";
export * from "./uri.ts";
export * from "./validate.ts";
export * from "./version.ts";
