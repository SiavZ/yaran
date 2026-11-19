import { ClipboardList } from "lucide-react"

import { Button } from "@yaran/ui-kit/button"
import { openBoard } from "@/lib/store"
import { useBoardWaiting } from "@/lib/useBoardWaiting"

// The phone hub's way to the human board, beside the menu button, with how many
// cards wait on the person running yaran. Ghost like the menu button; size-11
// keeps the touch floor, and the count rides inside the button, not beside it.
export function BoardHubButton() {
  const waiting = useBoardWaiting()
  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative size-11 shrink-0 [&_svg:not([class*='size-'])]:size-5"
      aria-label={
        waiting ? `Tasks for Human, ${waiting} waiting on you` : "Tasks for Human"
      }
      onClick={openBoard}
    >
      <ClipboardList />
      {waiting ? (
        <span
          aria-hidden
          className="absolute top-1 right-1 min-w-4 rounded-full bg-primary px-1 text-[10px] leading-4 font-medium text-primary-foreground tabular-nums"
        >
          {waiting > 99 ? "99+" : waiting}
        </span>
      ) : null}
    </Button>
  )
}
