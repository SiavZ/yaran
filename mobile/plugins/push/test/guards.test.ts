/**
 * The plugin contract's guards: event payload shapes, the D22 forbidden-field check at runtime
 * and at the type level, and the web stub's refusals.
 *
 * <module-headers:begin>
 * Uses:
 * test/guards.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/definitions.ts
 * ├── src/guards.ts
 * └── src/web.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/plugins/push)
 * <module-headers:end>
 */
import type { Device } from "@yaran/protocol";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  DistributorList,
  EndpointChangedEvent,
  LocalPushState,
  MachineNames,
  NotificationTappedEvent,
  PendingRegistrationsEvent,
  RegisterDeviceOptions,
  RegisterDeviceResult,
  RegistrationFailedEvent,
} from "../src/definitions.ts";
import {
  FORBIDDEN_BRIDGE_FIELDS,
  findForbiddenField,
  isEndpointChangedEvent,
  isNotificationTappedEvent,
  isPendingRegistrationsEvent,
  isRegistrationFailedEvent,
} from "../src/guards.ts";
import { PushWeb } from "../src/web.ts";

type DeepKeys<T> = T extends readonly (infer U)[] ? DeepKeys<U> : T extends object ? { [K in keyof T]-?: K | DeepKeys<T[K]> }[keyof T] : never;
type Forbidden = (typeof FORBIDDEN_BRIDGE_FIELDS)[number];
type Bridged =
  | RegisterDeviceOptions
  | RegisterDeviceResult
  | LocalPushState
  | DistributorList
  | MachineNames
  | NotificationTappedEvent
  | EndpointChangedEvent
  | RegistrationFailedEvent
  | PendingRegistrationsEvent;

describe("D22 bridge rule", () => {
  it("no plugin argument, result or event type has a forbidden field", () => {
    expectTypeOf<Extract<DeepKeys<Bridged>, Forbidden>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<DeepKeys<Device>, Forbidden>>().toEqualTypeOf<never>();
  });

  it("finds a forbidden key anywhere in a value", () => {
    expect(findForbiddenField({ outcome: "ok", device: { push: { endpoint_host: "relay.example.com" } } })).toBeNull();
    expect(findForbiddenField({ outcome: "ok", device: { push: { endpoint: "https://x" } } })).toBe("device.push.endpoint");
    expect(findForbiddenField([{ a: 1 }, { Keys: {} }])).toBe("[1].Keys");
    expect(findForbiddenField({ jwt: "eyJ" })).toBe("jwt");
  });
});

describe("event guards", () => {
  it("accepts well-formed taps and refuses the rest", () => {
    expect(isNotificationTappedEvent({ orgId: "o", machineId: "m", agentId: "a", action: "open" })).toBe(true);
    expect(isNotificationTappedEvent({ orgId: "o", machineId: "m", agentId: "a", tabId: "t", action: "open" })).toBe(true);
    expect(isNotificationTappedEvent({ orgId: "o", machineId: "m", action: "mute_machine" })).toBe(true);
    expect(isNotificationTappedEvent({ orgId: "o", machineId: "m", action: "open" })).toBe(false);
    expect(isNotificationTappedEvent({ orgId: "o", machineId: "", agentId: "a", action: "open" })).toBe(false);
    expect(isNotificationTappedEvent({ orgId: "o", machineId: "m", agentId: "a", action: "navigate", host: "evil.example" })).toBe(false);
    expect(isNotificationTappedEvent(null)).toBe(false);
  });

  it("checks the other events", () => {
    expect(isEndpointChangedEvent({ orgId: null })).toBe(true);
    expect(isEndpointChangedEvent({ orgId: "o" })).toBe(true);
    expect(isEndpointChangedEvent({})).toBe(false);
    expect(isRegistrationFailedEvent({ orgId: "o", reason: "" })).toBe(true);
    expect(isRegistrationFailedEvent({ orgId: "o" })).toBe(false);
    expect(isPendingRegistrationsEvent({ orgIds: ["a", "b"] })).toBe(true);
    expect(isPendingRegistrationsEvent({ orgIds: ["a", 1] })).toBe(false);
  });
});

describe("web stub", () => {
  it("rejects every method with unimplemented", async () => {
    const web = new PushWeb();
    const calls = [
      web.checkPermission(),
      web.requestPermission(),
      web.openNotificationSettings(),
      web.listDistributors(),
      web.selectDistributor(),
      web.registerDevice(),
      web.localState(),
      web.forgetOrg(),
      web.setLocalMutes(),
      web.cacheMachineNames(),
      web.setVisibleAgent(),
      web.clearDelivered(),
      web.drainPendingRegistrations(),
    ];
    for (const call of calls) await expect(call).rejects.toMatchObject({ code: "UNIMPLEMENTED" });
  });
});
