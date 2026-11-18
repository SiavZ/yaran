import { ChevronDown, Plus } from "lucide-react"
import { Fragment } from "react"

import { Button } from "@yaran/ui-kit/button"
import { ButtonGroup, ButtonGroupSeparator } from "@/components/ui/button-group"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@yaran/ui-kit/dropdown-menu"
import {
  launcherCornerModel,
  newLauncherModel,
  selectAgentCount,
  selectGhAvailable,
  selectProjectCount,
  type NewLauncherRow,
} from "@/lib/creationMenus"
import { openAgentTerminalPicker, useYaranSelector } from "@/lib/store"
import { cn } from "@yaran/ui-kit/cn"

// The launcher corner on every surface: the desktop sidebar's footer and the
// mobile hub, where it floats at the bottom-right corner, render this one
// component. One filled split button:
// the main half starts a new agent, and the ▾ half opens every other way to
// start something, as a menu (a bottom sheet on a phone).
//
// Both halves come from the New dialog's own groups (`newLauncherModel`), so an
// entry runs exactly what the dialog's copy of it runs, gated the same way.
// It subscribes to the three inputs alone, since it sits on screen all the time.
export function LauncherCorner({
  className,
  floating = false,
}: {
  className?: string
  // The phone hub's floating pill: the same two halves, 56px tall, rounder and
  // lifted by a shadow, shrink-wrapped instead of spanning a footer.
  floating?: boolean
}) {
  const ghAvailable = useYaranSelector(selectGhAvailable)
  const projectCount = useYaranSelector(selectProjectCount)
  const agentCount = useYaranSelector(selectAgentCount)
  const { primary, menu } = launcherCornerModel(
    newLauncherModel({ ghAvailable, projectCount, agentCount }),
  )
  return (
    // size="sm" is the one height token for both halves. On a computer they
    // are 28px tall, the per-axis exemption: the corner has no other control
    // above or below it. The ▾ half is 32px wide beside the main half, which a
    // mouse does not miss; where a finger is the pointer (a coarse pointer, or
    // a phone's width) both halves take the 44px floor in height and the ▾ half
    // in width as well, because a stray tap there would open the wrong one.
    <ButtonGroup
      className={cn("w-full", floating && "w-auto rounded-2xl shadow-lg", className)}
    >
      <Button
        size="sm"
        className={cn(
          "min-w-0 flex-1 max-md:min-h-11 pointer-coarse:min-h-11",
          floating && FLOATING_HALF,
          floating && "gap-2 pr-4 pl-5 text-base",
        )}
        onClick={() => run(primary)}
      >
        <Plus />
        {primary.menuTitle}
      </Button>
      <ButtonGroupSeparator className="bg-primary-foreground/20" />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="sm"
              aria-label="More ways to start"
              // The chevron points at the menu: down while it is closed and up
              // while it is open, read from the trigger's own open state.
              className={cn(
                "w-8 px-0 max-md:min-h-11 max-md:w-11 pointer-coarse:min-h-11 pointer-coarse:w-11 [&[data-popup-open]>svg]:rotate-180",
                floating && FLOATING_HALF,
                floating && "w-12 max-md:w-12 pointer-coarse:w-12",
              )}
            >
              <ChevronDown className="transition-transform motion-reduce:transition-none" />
            </Button>
          }
        />
        <DropdownMenuContent side="top" align="end" className="md:w-[23rem]">
          {menu.map((group, index) => (
            <Fragment key={group.id}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuGroup>
                <DropdownMenuLabel>{group.title}</DropdownMenuLabel>
                {group.lead ? (
                  <p className="px-1.5 pb-1 text-xs text-foreground">
                    {group.lead}
                  </p>
                ) : null}
                {group.rows.map((row) => (
                  <LauncherMenuEntry key={row.id} row={row} />
                ))}
              </DropdownMenuGroup>
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  )
}

// Both halves of the floating pill: one 56px height token, above the touch
// floor, and the pill's outer radius (the group squares the inner corners).
const FLOATING_HALF =
  "h-14 in-data-[slot=button-group]:rounded-2xl [&_svg:not([class*='size-'])]:size-5"

function LauncherMenuEntry({ row }: { row: NewLauncherRow }) {
  const Icon = row.icon
  return (
    <DropdownMenuItem
      data-row-id={row.id}
      disabled={row.disabled}
      onClick={() => run(row)}
      className="items-start gap-2.5 py-1.5"
    >
      <Icon className="mt-0.5 text-muted-foreground" />
      <span className="flex min-w-0 flex-col gap-px">
        <span data-entry-title="" className="font-medium">
          {row.menuTitle}
        </span>
        <span className="text-xs text-muted-foreground">{row.summary}</span>
      </span>
    </DropdownMenuItem>
  )
}

// The agent-picking step is the New dialog's own, opened on its own here.
function run(row: NewLauncherRow) {
  if (row.action.kind === "pick-agent") openAgentTerminalPicker()
  else row.action.run()
}
