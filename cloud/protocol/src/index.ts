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
 * ├── src/version.ts
 * ├── src/webpush/ece.ts
 * └── src/webpush/vapid.ts
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
 * ├── @yaran/qr:src/payload.ts
 * ├── yaran-cloud:scripts/assemble-deploy-tree.ts
 * ├── yaran-cloud:scripts/update/fetch-release.ts
 * ├── yaran-cloud:src/admin-api/routes.ts
 * ├── yaran-cloud:src/admin/audit-query.ts
 * ├── yaran-cloud:src/admin/pairing-service.ts
 * ├── yaran-cloud:src/admin/ports.ts
 * ├── yaran-cloud:src/admin/settings-apply.ts
 * ├── yaran-cloud:src/admin/settings-schema.ts
 * ├── yaran-cloud:src/admin/stale-policy.ts
 * ├── yaran-cloud:src/admin/users.ts
 * ├── yaran-cloud:src/audit/actions.ts
 * ├── yaran-cloud:src/audit/audit.ts
 * ├── yaran-cloud:src/auth/authorize.ts
 * ├── yaran-cloud:src/auth/machine-signature.ts
 * ├── yaran-cloud:src/auth/nonce-store.ts
 * ├── yaran-cloud:src/cloudflare/errors.ts
 * ├── yaran-cloud:src/console/admin-pages-2.tsx
 * ├── yaran-cloud:src/console/admin-pages.tsx
 * ├── yaran-cloud:src/console/routes.ts
 * ├── yaran-cloud:src/console/ui/strings.ts
 * ├── yaran-cloud:src/console/user-pages.tsx
 * ├── yaran-cloud:src/db/settings.ts
 * ├── yaran-cloud:src/devices/device-params.ts
 * ├── yaran-cloud:src/devices/devices-repo.ts
 * ├── yaran-cloud:src/http/body.ts
 * ├── yaran-cloud:src/http/pipeline.ts
 * ├── yaran-cloud:src/http/responses.ts
 * ├── yaran-cloud:src/index.ts
 * ├── yaran-cloud:src/machine-api/claim.ts
 * ├── yaran-cloud:src/machine-api/config.ts
 * ├── yaran-cloud:src/machine-api/origin.ts
 * ├── yaran-cloud:src/machine-api/rotate.ts
 * ├── yaran-cloud:src/machine-api/unpair.ts
 * ├── yaran-cloud:src/machines/machine-view-model.ts
 * ├── yaran-cloud:src/me/cursor.ts
 * ├── yaran-cloud:src/me/devices-route.ts
 * ├── yaran-cloud:src/me/machines-route.ts
 * ├── yaran-cloud:src/me/me-route.ts
 * ├── yaran-cloud:src/pairing/authorize-page.ts
 * ├── yaran-cloud:src/pairing/authorize-params.ts
 * ├── yaran-cloud:src/pairing/authorize-route.ts
 * ├── yaran-cloud:src/pairing/pair-requests.ts
 * ├── yaran-cloud:src/pairing/pkce.ts
 * ├── yaran-cloud:src/pairing/qr.ts
 * ├── yaran-cloud:src/provisioning/context.ts
 * ├── yaran-cloud:src/provisioning/engine.ts
 * ├── yaran-cloud:src/provisioning/index.ts
 * ├── yaran-cloud:src/provisioning/ports.ts
 * ├── yaran-cloud:src/provisioning/provision-error.ts
 * ├── yaran-cloud:src/provisioning/quota.ts
 * ├── yaran-cloud:src/provisioning/settings.ts
 * ├── yaran-cloud:src/push/consumer.ts
 * ├── yaran-cloud:src/push/deps.ts
 * ├── yaran-cloud:src/push/endpoint_policy.ts
 * ├── yaran-cloud:src/push/events_route.ts
 * ├── yaran-cloud:src/push/fanout.ts
 * ├── yaran-cloud:src/push/send.ts
 * ├── yaran-cloud:src/push/settings.ts
 * ├── yaran-cloud:src/push/store.ts
 * ├── yaran-cloud:src/push/test_route.ts
 * ├── yaran-cloud:src/push/types.ts
 * ├── yaran-cloud:src/routes/call.ts
 * ├── yaran-cloud:src/routes/meta.ts
 * ├── yaran-cloud:src/routes/phase06-context.ts
 * ├── yaran-cloud:src/routes/phase07-context.ts
 * ├── yaran-cloud:src/security/data-key.ts
 * ├── yaran-cloud:src/sessions/handoff-csrf.ts
 * ├── yaran-cloud:src/sessions/handoff-page.ts
 * ├── yaran-cloud:src/sessions/handoff-params.ts
 * ├── yaran-cloud:src/sessions/handoff-remembered.ts
 * ├── yaran-cloud:src/sessions/handoff-route.ts
 * ├── yaran-cloud:src/setup/setup-gate.ts
 * ├── yaran-cloud:src/setup/steps/access.ts
 * ├── yaran-cloud:src/setup/steps/claim.ts
 * ├── yaran-cloud:src/setup/steps/keys.ts
 * ├── yaran-cloud:src/update/release-manifest.ts
 * ├── yaran-cloud:src/update/update-checker.ts
 * ├── yaran-cloud:test/admin-services.test.ts
 * ├── yaran-cloud:test/audit.test.ts
 * ├── yaran-cloud:test/console.test.ts
 * ├── yaran-cloud:test/data-key.test.ts
 * ├── yaran-cloud:test/devices/device-fixtures.ts
 * ├── yaran-cloud:test/devices/devices-route.test.ts
 * ├── yaran-cloud:test/ed25519.test.ts
 * ├── yaran-cloud:test/error-codes.test.ts
 * ├── yaran-cloud:test/helpers/machine.ts
 * ├── yaran-cloud:test/machine-api/claim.test.ts
 * ├── yaran-cloud:test/machine-api/machine-routes.test.ts
 * ├── yaran-cloud:test/machine-signature.test.ts
 * ├── yaran-cloud:test/machines/machine-view-model.test.ts
 * ├── yaran-cloud:test/me/machines-route.test.ts
 * ├── yaran-cloud:test/me/me-route.test.ts
 * ├── yaran-cloud:test/me/meta.test.ts
 * ├── yaran-cloud:test/no-secret-leak.test.ts
 * ├── yaran-cloud:test/node/update-job.test.ts
 * ├── yaran-cloud:test/pairing/authorize-route.test.ts
 * ├── yaran-cloud:test/pairing/pair-helpers.ts
 * ├── yaran-cloud:test/phase06/fakes.ts
 * ├── yaran-cloud:test/phase06/harness.ts
 * ├── yaran-cloud:test/provisioning/errors.test.ts
 * ├── yaran-cloud:test/provisioning/origin-port.test.ts
 * ├── yaran-cloud:test/provisioning/registry.test.ts
 * ├── yaran-cloud:test/provisioning/rotate.test.ts
 * ├── yaran-cloud:test/provisioning/teardown.test.ts
 * ├── yaran-cloud:test/push/consumer.test.ts
 * ├── yaran-cloud:test/push/endpoint_policy.test.ts
 * ├── yaran-cloud:test/push/events_route.test.ts
 * ├── yaran-cloud:test/push/helpers/fakes.ts
 * ├── yaran-cloud:test/routes.test.ts
 * ├── yaran-cloud:test/sessions/handoff-helpers.ts
 * ├── yaran-cloud:test/sessions/handoff-remembered.test.ts
 * ├── yaran-cloud:test/sessions/handoff-route.test.ts
 * ├── yaran-cloud:test/setup-steps.test.ts
 * ├── yaran-cloud:test/update-checker.test.ts
 * ├── yaran-push-relay:src/apns/client.ts
 * ├── yaran-push-relay:src/apns/jwt.ts
 * ├── yaran-push-relay:src/core/endpoint_codec.ts
 * ├── yaran-push-relay:src/core/handler.ts
 * ├── yaran-push-relay:src/core/http.ts
 * ├── yaran-push-relay:src/core/mint.ts
 * ├── yaran-push-relay:src/core/receive.ts
 * ├── yaran-push-relay:src/fcm/client.ts
 * ├── yaran-push-relay:src/fcm/oauth.ts
 * ├── yaran-push-relay:test/fcm.test.ts
 * ├── yaran-push-relay:test/helpers/env.ts
 * └── yaran-push-relay:test/relay.test.ts
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
export * from "./webpush/ece.ts";
export * from "./webpush/vapid.ts";
