/**
 * The per-org notification row states, their presentation, and the permission flow.
 *
 * `OrgRowState` is the one exhaustive union every push surface renders; `rowView` words it and
 * names the row's action. The permission flow asks only from an explicit "Turn on
 * notifications" step, shows the rationale sheet when Android asks for one, and offers system
 * settings on every permanent deny.
 *
 * - Reasons shown in a row come from native code or the Worker and are sanitized here.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/pushPermission.ts
 * ├── @yaran/push:src/index.ts
 * └── src/push/pushStrings.ts
 * External: none
 *
 * Used by:
 * src/push/pushPermission.ts
 * ├── src/push/NotificationSettingsSection.tsx
 * ├── src/push/pushPermission.test.ts
 * ├── src/push/pushRegistration.ts
 * ├── src/push/pushTestKit.ts
 * └── src/push/pushWiring.ts
 * <module-headers:end>
 */
import type { NotificationPermission, PushPlugin } from "@yaran/push";
import type { PushStringKey } from "./pushStrings.ts";

export type OrgRowState =
  | { kind: "active" }
  | { kind: "needs_permission" }
  | { kind: "no_distributor" }
  | { kind: "push_unavailable"; reason: string }
  | { kind: "registration_failed"; reason: string }
  | { kind: "refresh_pending" }
  | { kind: "delivery_failing" }
  | { kind: "org_disabled" }
  | { kind: "muted"; until: string | null }
  | { kind: "turned_off" };

export type RowAction = "turn_on" | "allow" | "open_settings" | "distributors" | "retry" | "unmute" | null;

export interface RowView {
  title: PushStringKey;
  detail: string | null;
  action: RowAction;
  /** Whether the row offers the mute controls and the off switch. */
  registered: boolean;
}

export function assertNever(value: never): never {
  throw new Error(`unhandled push state ${JSON.stringify(value)}`);
}

/** Strips control and bidi characters and caps a reason for display. */
export function sanitizeReason(text: string): string {
  // Stripping control characters is the point of this pattern.
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, "").trim();
  return [...cleaned].slice(0, 200).join("");
}

export function rowView(state: OrgRowState): RowView {
  switch (state.kind) {
    case "active":
      return { title: "push.row.active", detail: null, action: null, registered: true };
    case "needs_permission":
      return { title: "push.row.needs_permission", detail: null, action: "allow", registered: false };
    case "no_distributor":
      return { title: "push.row.no_distributor", detail: null, action: "distributors", registered: false };
    case "push_unavailable":
      return { title: "push.row.push_unavailable", detail: sanitizeReason(state.reason), action: "retry", registered: false };
    case "registration_failed":
      return { title: "push.row.registration_failed", detail: sanitizeReason(state.reason), action: "retry", registered: false };
    case "refresh_pending":
      return { title: "push.row.refresh_pending", detail: null, action: null, registered: true };
    case "delivery_failing":
      return { title: "push.row.delivery_failing", detail: null, action: null, registered: true };
    case "org_disabled":
      return { title: "push.row.org_disabled", detail: null, action: null, registered: false };
    case "muted":
      return { title: state.until ? "push.row.muted.until" : "push.row.muted", detail: null, action: "unmute", registered: true };
    case "turned_off":
      return { title: "push.row.turned_off", detail: null, action: "turn_on", registered: false };
    default:
      return assertNever(state);
  }
}

export type PermissionStep = "granted" | "ask" | "rationale" | "open_settings";

export function nextPermissionStep(state: NotificationPermission): PermissionStep {
  switch (state) {
    case "granted":
      return "granted";
    case "prompt":
      return "ask";
    case "prompt-with-rationale":
      return "rationale";
    case "denied":
      return "open_settings";
    default:
      return assertNever(state);
  }
}

export interface PermissionUi {
  /** Shows the rationale sheet; resolves true when the user wants to continue. */
  showRationale(): Promise<boolean>;
  /** Offers "Open system settings"; resolves true when the user takes it. */
  offerSettings(): Promise<boolean>;
}

/**
 * The explicit "Turn on notifications" step: never called at launch.
 * Resolves "granted" only when the OS granted the permission.
 */
export async function turnOnPermission(push: PushPlugin, ui: PermissionUi): Promise<"granted" | "declined" | "settings"> {
  let step = nextPermissionStep((await push.checkPermission()).notifications);
  if (step === "granted") return "granted";
  if (step === "rationale" && !(await ui.showRationale())) return "declined";
  if (step === "ask" || step === "rationale") {
    step = nextPermissionStep((await push.requestPermission()).notifications);
    if (step === "granted") return "granted";
    if (step !== "open_settings") return "declined";
  }
  if (await ui.offerSettings()) {
    await push.openNotificationSettings();
    return "settings";
  }
  return "declined";
}
