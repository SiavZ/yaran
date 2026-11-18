import { Smartphone } from "lucide-react"

import { DropdownMenuItem } from "@yaran/ui-kit/dropdown-menu"
import { copyPhoneLink, usePhoneLinkTarget } from "@/lib/phoneLink"

// "Copy phone link" for an agent (no `tabId`: its first tab) or one of its tabs.
// Always present and never disabled: where no link can be made, the press says why
// (a refusal toast) instead of the item vanishing. No ellipsis: it opens no dialog.
export function CopyPhoneLinkItem({ agentId, tabId }: { agentId: string; tabId?: string }) {
  const link = usePhoneLinkTarget()
  return (
    <DropdownMenuItem onClick={() => copyPhoneLink(link, agentId, tabId)}>
      <Smartphone />
      Copy phone link
    </DropdownMenuItem>
  )
}
