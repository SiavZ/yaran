/**
 * Pure validators for the control-plane handoff request (W16 `HandoffQuery`) and its
 * consent form (W16b `HandoffConsent`), in 02 §8's order.
 *
 * Every refusal says whether it may be redirected: only when `build`, `redirect` and
 * `state` are valid does the route answer with a redirect to the app's callback;
 * anything else is a plain 400, so nothing is ever sent to an unlisted URL.
 *
 * - No I/O; the clock is a parameter.
 * - Points are decoded and checked on-curve through @yaran/protocol, the D24 device
 *   fields through its `checkHandoffDeviceFields`; nothing is re-implemented here.
 *
 * <module-headers:begin>
 * Uses:
 * src/sessions/handoff-params.ts
 * └── @yaran/protocol:src/index.ts
 * External: none
 *
 * Used by:
 * src/sessions/handoff-params.ts
 * ├── src/sessions/handoff-page.ts
 * ├── src/sessions/handoff-remembered.ts
 * ├── src/sessions/handoff-route.ts
 * ├── test/sessions/handoff-params.test.ts
 * └── test/sessions/handoff-remembered.test.ts
 * <module-headers:end>
 */
import {
  checkHandoffDeviceFields,
  decodeP256Point,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  redirectAllowed,
  type ErrorCode,
  type HandoffBuild,
  type HandoffMode,
} from "@yaran/protocol";

const STATE_RE = /^[A-Za-z0-9_-]{22,128}$/;
const CSRF_RE = /^[A-Za-z0-9_-]{22,128}$/;
const V_RE = /^[1-9][0-9]{0,4}$/;
// C0/C1 controls and the bidi marks, embeddings, overrides and isolates (Trojan Source).
const DEVICE_BAD_RE = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/u;

/** Where a refusal may be redirected; null means a plain 400. */
export interface RedirectTarget {
  redirect: string;
  state: string;
  mode: HandoffMode;
}

export interface HandoffCommon {
  v: number;
  pk: string;
  state: string;
  redirect: string;
  build: HandoffBuild;
  mode: HandoffMode;
  device: string;
  dk: string;
}

export interface HandoffGet extends HandoffCommon {
  dts: string;
  dsig: string;
}

export interface HandoffPost extends HandoffCommon {
  csrf: string;
  decision: "continue" | "cancel";
}

export interface Refusal {
  ok: false;
  code: ErrorCode;
  target: RedirectTarget | null;
  /** Extra callback parameters and envelope details (min/max, server_time). */
  extra: Record<string, number>;
}

export type Parsed<T> = { ok: true; value: T; target: RedirectTarget } | Refusal;

/** Reads a field from a query string or form; the absent value is null. */
export type Fields = { get(name: string): string | null };

export function deviceLabelValid(device: string): boolean {
  const n = [...device].length;
  return n >= 1 && n <= 64 && !DEVICE_BAD_RE.test(device);
}

function refuse(code: ErrorCode, target: RedirectTarget | null, extra: Record<string, number> = {}): Refusal {
  return { ok: false, code, target, extra };
}

/** The fields W16 and W16b share, validated in 02 §8's order. */
function parseCommon(f: Fields, configured: readonly string[]): Parsed<HandoffCommon> {
  const rawBuild = f.get("build");
  const build: HandoffBuild | null = rawBuild === null || rawBuild === "release" ? "release" : rawBuild === "dev" ? "dev" : null;
  const redirect = f.get("redirect") ?? "";
  const state = f.get("state") ?? "";
  const rawMode = f.get("mode");
  const mode: HandoffMode | null = rawMode === null || rawMode === "query" ? "query" : rawMode === "fragment" ? "fragment" : null;
  const redirectOk = build !== null && redirect.length <= 256 && redirectAllowed(redirect, build, configured);
  const target: RedirectTarget | null = redirectOk && STATE_RE.test(state) ? { redirect, state, mode: mode ?? "query" } : null;

  const v = f.get("v");
  if (v === null || !V_RE.test(v)) return refuse("handoff_request_invalid", target);
  if (Number(v) < PROTOCOL_MIN || Number(v) > PROTOCOL_MAX) return refuse("protocol_unsupported", target, { min: PROTOCOL_MIN, max: PROTOCOL_MAX });
  if (!redirectOk || !target) return refuse("handoff_request_invalid", null);
  if (mode === null) return refuse("handoff_request_invalid", target);
  const device = f.get("device") ?? "";
  if (!deviceLabelValid(device)) return refuse("handoff_request_invalid", target);
  const pk = f.get("pk") ?? "";
  if (!decodeP256Point(pk)) return refuse("handoff_request_invalid", target);
  return { ok: true, target, value: { v: Number(v), pk, state, redirect, build: build!, mode: target.mode, device, dk: f.get("dk") ?? "" } };
}

/** W16: the common fields, then dk, dts and dsig form and freshness (02 §8.1). */
export function parseHandoffQuery(f: Fields, configured: readonly string[], now: number): Parsed<HandoffGet> {
  const common = parseCommon(f, configured);
  if (!common.ok) return common;
  const dts = f.get("dts");
  const dsig = f.get("dsig");
  const device = checkHandoffDeviceFields({ dk: f.get("dk"), dts, dsig }, now);
  if (device) return refuse(device.code, common.target, device.serverTime === undefined ? {} : { server_time: device.serverTime });
  return { ok: true, target: common.target, value: { ...common.value, dts: dts!, dsig: dsig! } };
}

/** W16b: the common fields, dk re-checked as the GET did, then csrf and decision. */
export function parseHandoffConsent(f: Fields, configured: readonly string[]): Parsed<HandoffPost> {
  const common = parseCommon(f, configured);
  if (!common.ok) return common;
  if (!decodeP256Point(common.value.dk)) return refuse("handoff_device_key_invalid", common.target);
  const csrf = f.get("csrf") ?? "";
  const decision = f.get("decision");
  if (!CSRF_RE.test(csrf) || (decision !== "continue" && decision !== "cancel")) return refuse("handoff_request_invalid", common.target);
  return { ok: true, target: common.target, value: { ...common.value, csrf, decision } };
}

/** `<redirect>?state=…&<params>` or the fragment form, state always first. */
export function callbackUrl(t: RedirectTarget, params: Record<string, string | number>): string {
  const q = new URLSearchParams({ state: t.state });
  for (const [k, v] of Object.entries(params)) q.set(k, String(v));
  return `${t.redirect}${t.mode === "fragment" ? "#" : "?"}${q.toString()}`;
}
