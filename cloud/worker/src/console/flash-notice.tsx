/**
 * Renders a one-shot outcome message: what happened, to which named target, in words.
 *
 * - Every kind has its own sentence (an exhaustive table), with the target as a chip.
 */
import { Chip, Notice, type NoticeTone } from "./ui/components.tsx";
import type { Flash, FlashKind } from "./flash.ts";

const TEXT: Record<FlashKind, [NoticeTone, string, string]> = {
  unpaired: ["success", "Unpairing started for the machine", "Its tunnel, DNS record and Access application are being removed in the background."],
  phone_removed: ["success", "Removed the phone", "It no longer receives notifications from this org."],
  user_disabled: ["success", "Disabled", "They can no longer sign in."],
  user_enabled: ["success", "Enabled", "They can sign in again."],
  role_changed: ["success", "Changed the role of", ""],
  last_admin: ["error", "Refused for", "It would leave the org with no active admin (last_admin). Promote someone else first."],
  user_gone: ["info", "The user", "was already removed, so nothing changed."],
  machine_revoked: ["success", "Revoking the machine", "Its Cloudflare objects are being removed in the background; it disappears from the list when that finishes."],
  machine_rotated: ["success", "Rotated the tunnel token of", "The machine picks up the new token on its next signed call."],
  device_removed: ["success", "Removed the phone", "It no longer receives notifications from this org."],
  settings_saved: ["success", "Saved the settings", ""],
  workers_dev_disabled: ["success", "Turned off the workers.dev address", ""],
  workers_dev_failed: ["error", "Cloudflare refused to turn off the workers.dev address", "It still refuses every request. Check the token's Workers Scripts permission and retry."],
  token_replaced: ["success", "Replaced the Cloudflare API token", "Every permission passed the check before the old token was overwritten."],
  update_checked: ["info", "Checked for updates", ""],
};

export function FlashNotice(props: { flash: Flash | null }) {
  const f = props.flash;
  if (!f) return null;
  const known = Object.hasOwn(TEXT, f.kind) ? f.kind : null;
  if (!known) return null;
  const [tone, lead, tail] = TEXT[known];
  return (
    <Notice tone={tone}>
      {lead}
      {f.target ? (
        <>
          {" "}
          <Chip>{f.target}</Chip>
        </>
      ) : null}
      . {tail}
      {f.extra?.map((x) => (
        <>
          {" "}
          {x}
        </>
      ))}
    </Notice>
  );
}

