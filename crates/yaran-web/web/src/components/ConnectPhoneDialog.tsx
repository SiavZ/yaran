import { type ReactNode, useEffect, useState } from "react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@yaran/ui-kit/dialog"
import { cloudApi, type PhoneQr } from "@/lib/cloudApi"
import { phoneApi, type MachineQr } from "@/lib/phoneApi"
import { chip, renderProse, type Prose } from "@/lib/prose"
import { closeConnectPhone, useYaran } from "@/lib/store"

// "Connect a phone…": QR codes for the yaran app. A Report: read-only, one Close
// button, nothing destructive. Two ways in, each its own section: the organisation's
// code while this machine is paired (it shows only while it is, so it leaves the
// dialog the moment pairing ends), and this machine's own address, which needs no
// organisation and which the server offers only over an HTTPS address it can vouch
// for. Where it cannot, the section says why and what to do instead.
export function ConnectPhoneDialog() {
  const { connectPhoneOpen, bootstrap } = useYaran()
  const paired = bootstrap?.cloud?.paired ?? false

  return (
    <Dialog open={connectPhoneOpen} onOpenChange={(open) => (open ? null : closeConnectPhone())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connect a phone</DialogTitle>
        </DialogHeader>
        {connectPhoneOpen && paired ? (
          <Section title="Through your organisation">
            <PhoneQrBody />
          </Section>
        ) : null}
        {connectPhoneOpen ? (
          <Section title={paired ? "Or directly, by this machine's address" : "By this machine's address"}>
            <MachineQrBody />
          </Section>
        ) : null}
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  )
}

type Load<T> = { phase: "loading" } | { phase: "ready"; value: T } | { phase: "failed"; message: string }

// Mounted per open, so every open fetches a fresh answer and starts from loading.
function useLoad<T>(get: () => Promise<T>, fallback: string): Load<T> {
  const [load, setLoad] = useState<Load<T>>({ phase: "loading" })
  useEffect(() => {
    let live = true
    get()
      .then((value) => live && setLoad({ phase: "ready", value }))
      .catch(
        (e: unknown) =>
          live && setLoad({ phase: "failed", message: e instanceof Error ? e.message : fallback }),
      )
    return () => {
      live = false
    }
  }, [get, fallback])
  return load
}

function QrImage({ svg, alt }: { svg: string; alt: string }) {
  return (
    <img alt={alt} className="size-56 self-center" src={`data:image/svg+xml,${encodeURIComponent(svg)}`} />
  )
}

function PhoneQrBody() {
  const load = useLoad<PhoneQr>(cloudApi.phoneQr, "Could not load the phone code.")
  if (load.phase === "loading") return <DialogDescription>Loading the phone code…</DialogDescription>
  if (load.phase === "failed") return <DialogDescription>{load.message}</DialogDescription>
  const text: Prose = [
    "Open the yaran app on your phone and scan this, or type ",
    chip(load.value.url),
    " into it. You'll sign in with your organisation's single sign-on.",
  ]
  return (
    <>
      <QrImage svg={load.value.svg} alt="QR code for the yaran app" />
      <DialogDescription>{renderProse(text)}</DialogDescription>
    </>
  )
}

function MachineQrBody() {
  const load = useLoad<MachineQr>(phoneApi.machineQr, "Could not load this machine's code.")
  if (load.phase === "loading") return <DialogDescription>Loading this machine's code…</DialogDescription>
  if (load.phase === "failed") return <DialogDescription>{load.message}</DialogDescription>
  const text: Prose = [
    "Scan this in the yaran app to add this machine by its address, ",
    chip(load.value.host),
    ". No organisation is needed. If this machine asks for its password there, you enter it once, in the app.",
  ]
  return (
    <>
      <QrImage svg={load.value.svg} alt="QR code that adds this machine to the yaran app" />
      <DialogDescription>{renderProse(text)}</DialogDescription>
    </>
  )
}
