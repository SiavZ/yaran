/**
 * Phase 07 and 04 settings seam: 07's `settings.read()` returning 02's `Settings`, and
 * the Worker-internal settings rows 04 owns (control-plane host, team domain, zone).
 *
 * - Declarations only; 07's settings module and 04's `db/settings.ts` implement them.
 *
 * <module-headers:begin>
 * Uses:
 * src/seams/console.ts
 * └── @yaran/protocol:src/index.ts
 * External: none
 *
 * Used by:
 * src/seams/console.ts
 * ├── src/seams/context.ts
 * └── test/phase06/fakes.ts
 * <module-headers:end>
 */
import type { Settings } from "@yaran/protocol";

/** 04 internal settings keys (04 design §12 table); null until setup writes them. */
export interface InternalSettings {
  setupState: "open" | "closed";
  controlPlaneHost: string | null;
  teamDomain: string | null;
  zoneName: string | null;
  accountId: string | null;
  /** 08's org VAPID public key (raw P256Point), null while push is off or unset. */
  vapidPublicKey: string | null;
}

export interface SettingsReader {
  read(): Promise<Settings>;
  internal(): Promise<InternalSettings>;
}
