/**
 * Per-org push orchestration in the shell: register, reconcile on every foreground, turn off,
 * remove, drain endpoint changes queued while the WebView was not running, and sync mutes.
 *
 * Native code holds every key and endpoint and performs every Worker call (D22): registration
 * through `Push.registerDevice`, listing, mutes and removal through Phase 15's
 * `Session.request`. This module only decides when, and maps answers to `OrgRowState`.
 *
 * - Reconcile re-registers the current device when the Worker marked it `gone` or
 *   `auth_failed`, when its VAPID key differs from `Meta.push.vapid_public_key`, when the relay
 *   key id moved, or when the local subscription or endpoint host disagrees; `failing` is only
 *   shown. Every path that meets `device_revoked` forgets the org's local push state.
 * - "Turn off" re-registers with `push: {kind: none}` and never calls W14; removing the org does.
 * - Every step runs in the org's turn, owned by `MuteSync` (`muteSync.ts`).
 *
 * <module-headers:begin>
 * Uses:
 * src/push/pushRegistration.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/push:src/index.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/push/muteSync.ts
 * └── src/push/pushPermission.ts
 * External: none
 *
 * Used by:
 * src/push/pushRegistration.ts
 * ├── src/push/muteIntent.test.ts
 * ├── src/push/muteSync.ts
 * ├── src/push/pushDeps.ts
 * ├── src/push/pushRegistration.test.ts
 * ├── src/push/pushTestKit.ts
 * └── src/push/pushWiring.ts
 * <module-headers:end>
 */
import type { Device, DevicePage, Meta } from "@yaran/protocol";
import { findForbiddenField, type PushMutes, type PushPlugin, type RegisterDeviceResult } from "@yaran/push";
import type { ApiResult, SessionPlugin } from "../lib/native/machineView.ts";
import type { MuteSync } from "./muteSync.ts";
import { assertNever, type OrgRowState } from "./pushPermission.ts";

export type { ApiResult };

/** Phase 15's `Session.request`, plus `/v1/meta` already validated as a `Meta` (rejects otherwise). */
export interface SessionApi {
  meta(options: { orgUrl: string }): Promise<Meta>;
  request: SessionPlugin["request"];
}

export interface PushDeps {
  push: PushPlugin;
  session: SessionApi;
  /**
   * Whether the org this work is for is still the one on this phone (`scopedPushDeps`). Absent:
   * always. Checked again after each await before any local state (the mute queue) changes.
   */
  live?: () => boolean;
}

/** A push step refused because the org it was for is gone, or erased and added again. */
export class StalePushOrg extends Error {
  constructor() {
    super('the org this push work was for is no longer the one on this phone');
  }
}

export interface PushOrg {
  orgId: string;
  orgUrl: string;
  orgName: string;
  /** 02 `InstallId` from `Session.installId`. */
  installId: string;
  label: string;
  locale?: string;
  machines: { id: string; name: string }[];
}

export type ReconcileResult =
  | { kind: "row"; state: OrgRowState; device: Device | null }
  /** The org does not offer push (`push.webpush` missing): no row at all. */
  | { kind: "hidden" }
  /** `403 device_revoked`: this phone was removed; local push state is already gone. */
  | { kind: "revoked" };

export const NO_MUTES: PushMutes = { mute_all: false, muted_until: null, muted_machine_ids: [] };

export function mutesOf(device: Device): PushMutes {
  return { mute_all: device.mute_all, muted_until: device.muted_until, muted_machine_ids: device.muted_machine_ids };
}

export function rowFromDevice(device: Device, now: number = Date.now()): OrgRowState {
  if (device.push.kind === "none") return { kind: "turned_off" };
  if (device.push_state === "failing") return { kind: "delivery_failing" };
  if (device.mute_all) return { kind: "muted", until: null };
  if (device.muted_until && Date.parse(device.muted_until) > now) return { kind: "muted", until: device.muted_until };
  return { kind: "active" };
}

/** Words for the native client's non-API failures. */
export function failureReason(kind: Exclude<ApiResult["kind"], "ok" | "api_error" | "device_revoked">): string {
  switch (kind) {
    case "session_expired":
      return "your session for this organization expired; sign in again";
    case "offline":
      return "this phone is offline";
    case "tls_error":
      return "the connection to the organization was not secure";
    case "refused":
      return "the app refused the request";
    case "protocol_unsupported":
      return "this app and the organization speak different protocol versions; update the app";
    default:
      return assertNever(kind);
  }
}

/** W13: the device row for this install (`current: true`), or why it could not be read. */
export async function currentDevice(deps: PushDeps, orgId: string): Promise<Device | null | "revoked" | { failure: string }> {
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const r = await deps.session.request({ orgId, method: "GET", path: `/v1/me/devices${query}` });
    switch (r.kind) {
      case "ok": {
        const body = r.body as DevicePage;
        const mine = body.items.find((d) => d.current);
        if (mine) return mine;
        cursor = body.next_cursor;
        if (!cursor) return null;
        break;
      }
      case "device_revoked":
        return "revoked";
      case "api_error":
        return { failure: r.error.error.code };
      case "session_expired":
      case "offline":
      case "tls_error":
      case "refused":
      case "protocol_unsupported":
        return { failure: failureReason(r.kind) };
      default:
        return assertNever(r);
    }
  }
  return null;
}

async function forget(deps: PushDeps, orgId: string): Promise<ReconcileResult> {
  await deps.push.forgetOrg({ orgId });
  return { kind: "revoked" };
}

/** Maps `Push.registerDevice`'s answer to a row, refusing any result that carries key material. */
async function fromRegistration(deps: PushDeps, orgId: string, r: RegisterDeviceResult): Promise<ReconcileResult> {
  const leaked = findForbiddenField(r);
  if (leaked) return { kind: "row", state: { kind: "registration_failed", reason: `native result carried ${leaked}` }, device: null };
  const row = (state: OrgRowState): ReconcileResult => ({ kind: "row", state, device: null });
  switch (r.outcome) {
    case "ok":
      await deps.push.setLocalMutes({ orgId, mutes: mutesOf(r.device) });
      return { kind: "row", state: rowFromDevice(r.device), device: r.device };
    case "device_revoked":
      return forget(deps, orgId);
    case "api_error":
      return row({ kind: "registration_failed", reason: r.code });
    case "session_expired":
    case "offline":
    case "tls_error":
    case "refused":
    case "protocol_unsupported":
      return row({ kind: "registration_failed", reason: failureReason(r.outcome) });
    case "needs_permission":
      return row({ kind: "needs_permission" });
    case "no_distributor":
      return row({ kind: "no_distributor" });
    case "push_unavailable":
      return row({ kind: "push_unavailable", reason: r.reason });
    case "registration_failed":
      return row({ kind: "registration_failed", reason: r.reason });
    default:
      return assertNever(r);
  }
}

/** Registers (or re-registers) this phone for one org. */
export async function registerOrg(deps: PushDeps, org: PushOrg, meta: Meta, mutes: PushMutes, pushOff = false): Promise<ReconcileResult> {
  const r = await deps.push.registerDevice({
    orgId: org.orgId,
    installId: org.installId,
    label: org.label,
    ...(org.locale ? { locale: org.locale } : {}),
    mutes,
    pushOff,
    vapidPublicKey: meta.push?.vapid_public_key ?? null,
  });
  return fromRegistration(deps, org.orgId, r);
}

/** A reconcile's or registration's answer, recorded in the org's turn so a later turn's answer always lands after it. */
export type Publish = (r: ReconcileResult) => Promise<void> | void;

/**
 * Every foreground: compares the Worker's record with the native subscription. The whole
 * decision (listing the device, reading the local state, registering or settling) and its
 * publication run in the org's one turn, so a Turn off or a mute queued meanwhile is never
 * undone by a decision made from a snapshot taken before it.
 */
export function reconcileOrg(deps: PushDeps, org: PushOrg, mutes: MuteSync, publish?: Publish): Promise<ReconcileResult> {
  return mutes.run(deps, org.orgId, () => decide(deps, org, mutes), publish);
}

async function decide(deps: PushDeps, org: PushOrg, mutes: MuteSync): Promise<ReconcileResult> {
  let meta: Meta;
  try {
    meta = await deps.session.meta({ orgUrl: org.orgUrl });
  } catch {
    return { kind: "row", state: { kind: "registration_failed", reason: failureReason("offline") }, device: null };
  }
  if (!meta.capabilities?.includes("push.webpush")) return { kind: "hidden" };
  if (!meta.push?.enabled) return { kind: "row", state: { kind: "org_disabled" }, device: null };
  await deps.push.cacheMachineNames({ orgId: org.orgId, orgName: org.orgName, machines: org.machines });

  const listed = await currentDevice(deps, org.orgId);
  if (listed === "revoked") return forget(deps, org.orgId);
  if (listed !== null && "failure" in listed) {
    return { kind: "row", state: { kind: "registration_failed", reason: listed.failure }, device: null };
  }
  // Listed in this turn, so no answer can be newer: it is what is in force now, with what is
  // still owed laid over it, before any registration below reads its mutes.
  const device = listed && mutes.taken(deps, org.orgId, listed);
  // A Turn on or Turn off the Worker has not confirmed yet is the user's latest word: it is retried.
  const owed = mutes.owedToggle(org.orgId);
  const register = () => mutes.registered(deps, org.orgId, device, (inForce, pushOff) => registerOrg(deps, org, meta, inForce, pushOff));
  if (owed === true) return register();
  if (device?.push.kind === "none" && owed === undefined) return { kind: "row", state: { kind: "turned_off" }, device };
  if ((await deps.push.checkPermission()).notifications !== "granted") {
    return { kind: "row", state: { kind: "needs_permission" }, device };
  }
  const local = await deps.push.localState({ orgId: org.orgId });
  const vapid = meta.push.vapid_public_key;
  const stale =
    device === null ||
    device.push.kind === "none" ||
    device.push_state === "gone" ||
    device.push_state === "auth_failed" ||
    device.push.vapid_public_key !== vapid ||
    !local.subscribed ||
    local.vapidPublicKey !== vapid ||
    local.relayKeyCurrent === false ||
    (device.push.endpoint_host ?? null) !== local.endpointHost;
  if (stale) return register();

  const current = await mutes.settled(deps, org.orgId, device);
  if (current === "revoked") return forget(deps, org.orgId);
  return { kind: "row", state: rowFromDevice(current), device: current };
}

/** "Turn off notifications for this org": `{kind: none}` by upsert, keys deleted; the device stays. */
export async function turnOffOrg(deps: PushDeps, org: PushOrg, meta: Meta, device: Device | null): Promise<ReconcileResult> {
  return registerOrg(deps, org, meta, device ? mutesOf(device) : NO_MUTES, true);
}

/** Org removal (Phase 14's flow): W14, then the local push keys. */
export async function removeOrgPush(deps: PushDeps, orgId: string, deviceId: string | null): Promise<ApiResult | null> {
  const r = deviceId ? await deps.session.request({ orgId, method: "DELETE", path: `/v1/me/devices/${encodeURIComponent(deviceId)}` }) : null;
  await deps.push.forgetOrg({ orgId });
  return r;
}

/** Endpoint changes queued natively while the WebView was not running. */
export async function drainPending(
  deps: PushDeps,
  orgs: PushOrg[],
  mutes: MuteSync,
  depsOf: (orgId: string) => PushDeps = () => deps,
  publish?: (orgId: string, r: ReconcileResult) => Promise<void> | void,
): Promise<Map<string, ReconcileResult>> {
  const { orgIds } = await deps.push.drainPendingRegistrations();
  const out = new Map<string, ReconcileResult>();
  // Each org in its own turn, side by side: one org's exchange never holds up another's.
  await Promise.all(
    orgs
      .filter((org) => orgIds.includes(org.orgId))
      .map(async (org) => {
        try {
          out.set(org.orgId, await reconcileOrg(depsOf(org.orgId), org, mutes, publish && ((r) => publish(org.orgId, r))));
        } catch (err) {
          // That org went stale mid-way (removed, or erased and added again): the others still run.
          if (!(err instanceof StalePushOrg)) throw err;
        }
      }),
  );
  return out;
}
