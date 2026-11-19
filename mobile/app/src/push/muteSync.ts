/**
 * The one owner of a phone's push state per org (`MuteSync`): the turn every reconcile,
 * registration, mute change and retry of an org runs in, the mutes in force, what is owed, and
 * a Turn on or Turn off the Worker has not confirmed yet. Split from `pushRegistration.ts`,
 * which decides what each step does.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/muteSync.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/push:src/index.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/push/pushPermission.ts
 * └── src/push/pushRegistration.ts
 * External: none
 *
 * Used by:
 * src/push/muteSync.ts
 * ├── src/push/muteIntent.test.ts
 * ├── src/push/pushDeps.ts
 * ├── src/push/pushRegistration.test.ts
 * ├── src/push/pushRegistration.ts
 * └── src/push/pushWiring.ts
 * <module-headers:end>
 */
import type { Device, DevicePatch } from "@yaran/protocol";
import type { PushMutes } from "@yaran/push";

import type { ApiResult } from "../lib/native/machineView.ts";
import { assertNever } from "./pushPermission.ts";
import { mutesOf, NO_MUTES, StalePushOrg, type PushDeps, type ReconcileResult } from "./pushRegistration.ts";

export type MuteOutcome = "saved" | "offline" | "unchanged" | "revoked" | "failed" | "full";

/** The most machines one device mutes (02 `Device.muted_machine_ids`). */
export const MAX_MUTED_MACHINES = 100;

/**
 * A mute change: a fixed patch, or one decided against the mutes in force when its turn comes
 * (the newest Worker answer, then every patch still owed). Deciding at the turn is what keeps
 * two quick taps from each sending a list built before the other landed.
 */
export type MuteChange = DevicePatch | ((inForce: PushMutes) => DevicePatch | "unchanged" | "full");

/**
 * The one owner of a phone's push state per org. Every reconcile, registration, change and
 * retry that reads or writes it runs in that org's turn, one at a time, and publishes its
 * answer there, so no answer retires or overwrites one newer than itself.
 *
 * - What is in force is the newest device the Worker accepted with every patch still owed laid
 *   over it. The native mirror always shows that, so the phone enforces an offline mute.
 * - Each PATCH carries every owed field with the new change over it (latest value wins per
 *   field), so a success settles all of them and none is dropped.
 * - Every turn, and every write after an await inside one, first checks that its org is still
 *   the one it began for (`deps.live`): a turn queued before a removal never writes the state
 *   of the org added again after it.
 * - shortcut: the owed patch lives in memory, so a process death before reconnecting drops it
 *   and the next reconcile mirrors the Worker again; persist it in 14's store if that bites.
 */
export class MuteSync {
  private pending = new Map<string, DevicePatch>();
  // The newest device the Worker accepted, per org.
  private known = new Map<string, Device>();
  // The `pushOff` of a user's Turn off (true) or Turn on (false) the Worker has not confirmed.
  private owed = new Map<string, boolean>();
  private turns = new Map<string, Promise<unknown>>();

  private turn<T>(orgId: string, job: () => Promise<T>): Promise<T> {
    const run = (this.turns.get(orgId) ?? Promise.resolve()).then(job);
    const tail = run.catch(() => undefined);
    this.turns.set(orgId, tail);
    void tail.then(() => this.turns.get(orgId) === tail && this.turns.delete(orgId));
    return run;
  }

  private check(deps: PushDeps): void {
    if (deps.live?.() === false) throw new StalePushOrg();
  }

  private inForce(orgId: string, device: Device | null): PushMutes {
    const base = this.known.get(orgId) ?? device;
    return { ...(base ? mutesOf(base) : NO_MUTES), ...this.pending.get(orgId) };
  }

  /** Records `device` as the newest the Worker accepted; inside a turn only. It confirms a matching owed toggle. */
  taken(deps: PushDeps, orgId: string, device: Device): Device {
    this.check(deps);
    this.known.set(orgId, device);
    if (this.owed.get(orgId) === (device.push.kind === "none")) this.owed.delete(orgId);
    return device;
  }

  /** A user's Turn off (`off`) or Turn on, owed until a device the Worker accepts says so; inside a turn only. */
  owe(deps: PushDeps, orgId: string, off: boolean): void {
    this.check(deps);
    this.owed.set(orgId, off);
  }

  owedToggle(orgId: string): boolean | undefined {
    return this.owed.get(orgId);
  }

  /**
   * Runs `job` in the org's turn and publishes its answer there. The org is checked before the
   * job touches anything and again before the answer is published.
   */
  run<T>(deps: PushDeps, orgId: string, job: () => Promise<T>, publish?: (r: T) => Promise<void> | void): Promise<T> {
    return this.turn(orgId, async () => {
      this.check(deps);
      const r = await job();
      this.check(deps);
      await publish?.(r);
      return r;
    });
  }

  apply(deps: PushDeps, orgId: string, device: Device, change: MuteChange): Promise<MuteOutcome | Device> {
    return this.run(deps, orgId, () => this.send(deps, orgId, device, change));
  }

  /**
   * A mute change whose device is looked up in the same turn (a cold notification has none
   * cached), so a change made after it was asked for always lands after it. Null: no device.
   */
  applyTo(deps: PushDeps, orgId: string, lookup: () => Promise<Device | null | "revoked">, change: MuteChange): Promise<MuteOutcome | Device | null> {
    return this.run(deps, orgId, async () => {
      let device: Device | null | "revoked";
      try {
        device = await lookup();
      } catch (err) {
        // A lookup that threw (for the org as it is now) saved and changed nothing: a failure.
        if (err instanceof StalePushOrg) throw err;
        this.check(deps);
        return "failed";
      }
      return device === null || device === "revoked" ? device : this.send(deps, orgId, device, change);
    });
  }

  private async send(deps: PushDeps, orgId: string, device: Device, change: MuteChange): Promise<MuteOutcome | Device> {
    this.check(deps);
    const before = this.inForce(orgId, device);
    const own = typeof change === "function" ? change(before) : change;
    if (own === "unchanged" || own === "full") return own;
    const outgoing: DevicePatch = { ...this.pending.get(orgId), ...own };
    let r: ApiResult;
    try {
      await deps.push.setLocalMutes({ orgId, mutes: { ...before, ...own } });
      r = await deps.session.request({ orgId, method: "PATCH", path: `/v1/me/devices/${encodeURIComponent(device.id)}`, body: outgoing });
    } catch (err) {
      // Thrown rather than answered: nothing is known to be saved. The mirror goes back to what
      // is in force and what was owed before stays owed; an org gone since touches nothing.
      if (err instanceof StalePushOrg) throw err;
      this.check(deps);
      await deps.push.setLocalMutes({ orgId, mutes: before }).catch(() => undefined);
      return "failed";
    }
    // A late answer for an org since removed (or erased and added again) must not set, replace
    // or delete the owed patch: that slot may now hold the new org's own.
    this.check(deps);
    switch (r.kind) {
      case "ok": {
        this.pending.delete(orgId);
        const updated = this.taken(deps, orgId, r.body as Device);
        await deps.push.setLocalMutes({ orgId, mutes: mutesOf(updated) });
        return updated;
      }
      case "offline":
        this.pending.set(orgId, outgoing);
        return "offline";
      case "device_revoked":
        this.pending.delete(orgId);
        this.known.delete(orgId);
        await deps.push.forgetOrg({ orgId });
        return "revoked";
      case "api_error":
      case "session_expired":
      case "tls_error":
      case "refused":
      case "protocol_unsupported":
        // Nothing new was saved: the mirror goes back to what is in force.
        await deps.push.setLocalMutes({ orgId, mutes: before });
        return "failed";
      default:
        return assertNever(r);
    }
  }

  /** Re-sends what is owed; returns the updated device, or null when nothing was owed. */
  flush(deps: PushDeps, orgId: string, device: Device): Promise<MuteOutcome | Device | null> {
    // Decided in its turn: an exchange still running may yet save or clear the owed patch.
    return this.run(deps, orgId, async () => (this.pending.has(orgId) ? this.send(deps, orgId, device, {}) : null));
  }

  /**
   * A reconcile's healthy ending, inside its turn: `fetched` (listed in this same turn) is the
   * newest device, what is owed is retried, and the mirror and the returned device show what
   * is in force, so an offline retry never publishes the Worker's older mutes as the truth.
   */
  async settled(deps: PushDeps, orgId: string, fetched: Device): Promise<Device | "revoked"> {
    this.taken(deps, orgId, fetched);
    if (this.pending.has(orgId) && (await this.send(deps, orgId, fetched, {})) === "revoked") return "revoked";
    this.check(deps);
    const mutes = this.inForce(orgId, fetched);
    await deps.push.setLocalMutes({ orgId, mutes });
    return { ...(this.known.get(orgId) ?? fetched), ...mutes };
  }

  /**
   * A (re-)registration inside a turn, carrying the mutes in force and the owed toggle (push
   * stays on when none is owed); a registration the Worker accepted holds every owed field, so
   * they are settled with it.
   */
  async registered(
    deps: PushDeps,
    orgId: string,
    device: Device | null,
    job: (mutes: PushMutes, pushOff: boolean) => Promise<ReconcileResult>,
  ): Promise<ReconcileResult> {
    this.check(deps);
    const r = await job(this.inForce(orgId, device), this.owed.get(orgId) ?? false);
    this.check(deps);
    if (r.kind === "row" && r.device) {
      this.pending.delete(orgId);
      this.taken(deps, orgId, r.device);
    }
    if (r.kind === "revoked") this.owed.delete(orgId);
    return r;
  }

  hasPending(orgId: string): boolean {
    return this.pending.has(orgId);
  }

  /** The org left this phone: a patch saved for it must never reach an org added again later. */
  forget(orgId?: string): void {
    // A new turn chain too: a turn of the org that left never holds up the one added again
    // (it refuses itself at its next check, see `run`).
    for (const map of [this.pending, this.known, this.owed, this.turns]) {
      if (orgId === undefined) map.clear();
      else map.delete(orgId);
    }
  }
}

/** Adds (`muted`) or removes one machine, decided against the mutes in force at its turn. */
export function machineMute(machineId: string, muted: boolean): MuteChange {
  return ({ muted_machine_ids: ids }) => {
    if (ids.includes(machineId) === muted) return "unchanged";
    if (muted && ids.length >= MAX_MUTED_MACHINES) return "full";
    return { muted_machine_ids: muted ? [...ids, machineId] : ids.filter((id) => id !== machineId) };
  };
}

export async function muteMachine(deps: PushDeps, sync: MuteSync, orgId: string, device: Device, machineId: string): Promise<MuteOutcome> {
  const r = await sync.apply(deps, orgId, device, machineMute(machineId, true));
  return typeof r === "object" ? "saved" : r;
}
