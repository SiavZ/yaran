import { useCallback, useEffect, useState } from "react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useVanishedTargetGuard } from "@/hooks/use-vanished-target"
import { cloudApi, type PhoneQr } from "@/lib/cloudApi"
import { notifyInfo } from "@/lib/notify"
import { chip, renderProse, type Prose } from "@/lib/prose"
import { closeConnectPhone, useYaran } from "@/lib/store"

// "Connect a phone…": the paired machine's QR code for the yaran app. A Report:
// read-only, one Close button, nothing destructive. It closes itself, and says so,
// when the machine stops being paired while it is open.
export function ConnectPhoneDialog() {
  const { connectPhoneOpen, bootstrap } = useYaran()
  const paired = bootstrap?.cloud?.paired ?? false
  const org = bootstrap?.cloud?.org_url ?? null

  const closeUnpaired = useCallback(() => {
    closeConnectPhone()
    notifyInfo([
      "This machine is no longer connected to ",
      ...(org ? [chip(org)] : ["its organisation"]),
      ", so there is no phone code to show. Connect it again with ",
      chip("yaran cloud login"),
      ".",
    ])
  }, [org])
  const isOpen = useVanishedTargetGuard(connectPhoneOpen, paired, closeUnpaired)

  return (
    <Dialog open={isOpen} onOpenChange={(open) => (open ? null : closeConnectPhone())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect a phone</DialogTitle>
        </DialogHeader>
        {isOpen ? <PhoneQrBody /> : null}
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}

type Load = { phase: "loading" } | { phase: "ready"; qr: PhoneQr } | { phase: "failed"; message: string }

// Mounted per open, so every open fetches a fresh code and starts from loading.
function PhoneQrBody() {
  const [load, setLoad] = useState<Load>({ phase: "loading" })
  useEffect(() => {
    let live = true
    cloudApi
      .phoneQr()
      .then((qr) => live && setLoad({ phase: "ready", qr }))
      .catch((e: unknown) =>
        live &&
        setLoad({
          phase: "failed",
          message: e instanceof Error ? e.message : "Could not load the phone code.",
        }),
      )
    return () => {
      live = false
    }
  }, [])

  if (load.phase === "loading") {
    return <DialogDescription>Loading the phone code…</DialogDescription>
  }
  if (load.phase === "failed") {
    return <DialogDescription>{load.message}</DialogDescription>
  }
  const text: Prose = [
    "Open the yaran app on your phone and scan this, or type ",
    chip(load.qr.url),
    " into it. You'll sign in with your organisation's single sign-on.",
  ]
  return (
    <div className="flex flex-col items-center gap-4">
      <img
        alt="QR code for the yaran app"
        className="size-56"
        src={`data:image/svg+xml,${encodeURIComponent(load.qr.svg)}`}
      />
      <DialogDescription>{renderProse(text)}</DialogDescription>
    </div>
  )
}
