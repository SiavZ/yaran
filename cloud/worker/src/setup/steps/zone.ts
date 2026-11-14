/**
 * Wizard step 4: the zone and the control-plane hostname.
 *
 * The admin picks a zone and a label (default `cp`): one DNS label with no hyphen, so it
 * can never collide with 05's `<machine>-<user>` hostnames. A hostname already used by a
 * DNS record or a Worker custom domain is refused with `hostname_conflict`. Recording it
 * as `control_plane_host` is the reservation 05's naming checks against. The zone is fixed
 * once setup closes.
 */
import type { CfTransport } from "../../admin/ports.ts";
import { workers, zones, type CfZone } from "../../cloudflare/setup-endpoints.ts";
import type { SetupEvent } from "../wizard-state.ts";

export const DEFAULT_LABEL = "cp";
const LABEL = /^[a-z0-9]{1,63}$/;

export type ZoneOutcome = { ok: true; event: SetupEvent } | { ok: false; problem: "invalid_label" | "unknown_zone" | "hostname_conflict" };

export function listZones(cf: CfTransport): Promise<CfZone[]> {
  return zones.list(cf);
}

export async function chooseHostname(cf: CfTransport, accountId: string, zoneId: string, rawLabel: string): Promise<ZoneOutcome> {
  const label = rawLabel.trim().toLowerCase();
  if (!LABEL.test(label)) return { ok: false, problem: "invalid_label" };
  const zone = (await zones.list(cf)).find((z) => z.id === zoneId);
  if (!zone) return { ok: false, problem: "unknown_zone" };
  const host = `${label}.${zone.name}`;
  const [records, domains] = await Promise.all([zones.findDnsRecord(cf, zone.id, host), workers.listDomains(cf, accountId, host)]);
  if (records.length > 0 || domains.some((d) => d.hostname === host)) return { ok: false, problem: "hostname_conflict" };
  return { ok: true, event: { kind: "hostname_chosen", zone_id: zone.id, zone_name: zone.name, cp_label: label } };
}
