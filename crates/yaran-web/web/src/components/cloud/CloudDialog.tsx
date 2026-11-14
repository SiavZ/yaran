/**
 * The Yaran Cloud dialog, opened from the app menu's "Yaran Cloud…": the pairing
 * status and the three actions the web offers, Connect, Rotate token… and
 * Disconnect….
 *
 * Connect starts the browser login on the server and opens the approval page in a
 * new tab from the click handler, because the browser may not be on the server's
 * machine. The dialog shows the machine-key fingerprint to compare with the page, and
 * a single-line field for the address a remote browser lands on. Results arrive as
 * the keyed toasts the engine already broadcasts; this file raises a toast only when
 * a request itself fails, through `lib/notify.ts`.
 *
 * - Fetches its own status while open and polls it while a login is waiting.
 * - Each destructive action has its own confirm dialog (Cancel autofocused).
 * - Names (org, hostname, fingerprint, URL) render as `InlineCode` chips.
 *
 * <module-headers:begin>
 * Uses:
 * src/components/cloud/CloudDialog.tsx
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/dialog.tsx
 * ├── @yaran/ui-kit:src/inline-code.tsx
 * ├── @yaran/ui-kit:src/input.tsx
 * ├── src/components/cloud/CloudLogoutDialog.tsx
 * ├── src/components/cloud/CloudRotateDialog.tsx
 * ├── src/lib/cloudApi.ts
 * ├── src/lib/notify.ts
 * └── src/lib/store.ts
 * External: lucide-react, react
 *
 * Used by:
 * src/components/cloud/CloudDialog.tsx
 * ├── src/App.tsx
 * └── src/components/cloud/CloudDialog.test.tsx
 * <module-headers:end>
 */

import { useCallback, useEffect, useState, type FormEvent } from "react"
import { ExternalLink, Loader2 } from "lucide-react"

import { Button } from "@yaran/ui-kit/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@yaran/ui-kit/dialog"
import { InlineCode } from "@yaran/ui-kit/inline-code"
import { Input } from "@yaran/ui-kit/input"
import { cloudApi, type CloudLogin, type CloudStatus } from "@/lib/cloudApi"
import { notifyError } from "@/lib/notify"
import { closeCloudDialog, useYaran } from "@/lib/store"

import { CloudLogoutDialog } from "./CloudLogoutDialog"
import { CloudRotateDialog } from "./CloudRotateDialog"

/** How often the dialog re-reads the status while a login waits on a browser. */
export const LOGIN_POLL_MS = 2_000

function messageOf(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

/** Open a URL in a new tab with no handle back to this page. */
function openInNewTab(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer")
}

export function CloudDialog() {
  const { cloudDialogOpen } = useYaran()
  return (
    <Dialog
      open={cloudDialogOpen}
      onOpenChange={(open) => !open && closeCloudDialog()}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        {/* Mounted only while open, so every reopen reads a fresh status. */}
        {cloudDialogOpen ? <CloudDialogBody /> : null}
      </DialogContent>
    </Dialog>
  )
}

type Confirm = "logout" | "rotate" | null

function CloudDialogBody() {
  const [status, setStatus] = useState<CloudStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [acting, setActing] = useState(false)

  const refresh = useCallback(
    () =>
      cloudApi.status().then(
        (s) => {
          setStatus(s)
          setLoadError(null)
        },
        (e) => setLoadError(messageOf(e, "Could not read the Yaran Cloud status.")),
      ),
    [],
  )

  useEffect(() => {
    // The first read; every later one comes from an action or the login poll.
    void cloudApi.status().then(setStatus, (e) =>
      setLoadError(messageOf(e, "Could not read the Yaran Cloud status.")),
    )
  }, [])

  // While a login waits on a browser, re-read the status: a browser on this
  // machine finishes through the loopback, which tells this page nothing.
  const waitingId = status?.active_login?.login_id ?? null
  useEffect(() => {
    if (!waitingId) return
    const timer = setInterval(() => void refresh(), LOGIN_POLL_MS)
    return () => clearInterval(timer)
  }, [waitingId, refresh])

  const setLogin = (login: CloudLogin | null) =>
    setStatus((s) => (s ? { ...s, active_login: login } : s))

  async function runAction(kind: "logout" | "rotate") {
    setConfirm(null)
    setActing(true)
    try {
      // The outcome sentence arrives as the keyed toast; only a failed request
      // needs one of this page's own.
      await (kind === "logout" ? cloudApi.logout() : cloudApi.rotate())
    } catch (e) {
      notifyError(messageOf(e, "The Yaran Cloud request failed."))
    } finally {
      setActing(false)
      void refresh()
    }
  }

  let body
  if (!status) {
    body = loadError ? (
      <p role="alert" className="text-sm text-destructive">
        {loadError}
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">Reading the status…</p>
    )
  } else if (status.active_login) {
    body = (
      <WaitingView
        login={status.active_login}
        onFinished={() => void refresh()}
        onCancelled={() => {
          setLogin(null)
          void refresh()
        }}
      />
    )
  } else if (status.paired) {
    body = (
      <PairedView
        status={status}
        acting={acting}
        onRotate={() => setConfirm("rotate")}
        onDisconnect={() => setConfirm("logout")}
      />
    )
  } else {
    body = <ConnectView status={status} onStarted={setLogin} />
  }

  const hostname = status?.hostname ?? "this machine"
  return (
    <>
      <DialogHeader>
        <DialogTitle>Yaran Cloud</DialogTitle>
      </DialogHeader>
      {body}
      <CloudLogoutDialog
        open={confirm === "logout"}
        hostname={hostname}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void runAction("logout")}
      />
      <CloudRotateDialog
        open={confirm === "rotate"}
        hostname={hostname}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void runAction("rotate")}
      />
    </>
  )
}

function ConnectView({
  status,
  onStarted,
}: {
  status: CloudStatus
  onStarted: (login: CloudLogin) => void
}) {
  const [orgUrl, setOrgUrl] = useState(status.default_org_url)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function connect(e: FormEvent) {
    e.preventDefault()
    if (starting || !orgUrl.trim()) return
    setStarting(true)
    setError(null)
    // Opened now, while the click still counts as a user gesture; a tab opened
    // after the await would be blocked as a popup. Cut off from this page first.
    const tab = window.open("about:blank", "_blank")
    if (tab) tab.opener = null
    try {
      const login = await cloudApi.startLogin(orgUrl.trim())
      if (tab) tab.location.href = login.authorize_url
      onStarted(login)
    } catch (err) {
      tab?.close()
      setError(messageOf(err, "Could not start the Yaran Cloud login."))
    } finally {
      setStarting(false)
    }
  }

  return (
    <form onSubmit={connect} className="flex flex-col gap-3">
      <DialogDescription>
        This machine is not connected to Yaran Cloud. Enter your
        organization&apos;s address to pair it; you approve the pairing in your
        browser.
      </DialogDescription>
      {status.error ? (
        <p role="alert" className="text-sm text-destructive">
          {status.error}
        </p>
      ) : null}
      <Input
        aria-label="Organization address"
        placeholder="https://cloud.example.com"
        value={orgUrl}
        onChange={(e) => setOrgUrl(e.target.value)}
        autoFocus
        disabled={starting}
        aria-invalid={error !== null}
        aria-describedby={error ? "cloud-connect-error" : undefined}
      />
      {error ? (
        <p id="cloud-connect-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={closeCloudDialog}>
          Close
        </Button>
        <Button type="submit" disabled={starting || !orgUrl.trim()} aria-busy={starting}>
          {starting ? <Loader2 className="motion-safe:animate-spin" /> : null}
          Connect
        </Button>
      </DialogFooter>
    </form>
  )
}

function WaitingView({
  login,
  onFinished,
  onCancelled,
}: {
  login: CloudLogin
  onFinished: () => void
  onCancelled: () => void
}) {
  const [address, setAddress] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function finish(e: FormEvent) {
    e.preventDefault()
    if (sending || !address.trim()) return
    setSending(true)
    setError(null)
    try {
      const { finished } = await cloudApi.completeLogin(login.login_id, address.trim())
      if (finished) onFinished()
    } catch (err) {
      setError(messageOf(err, "The address was not accepted."))
    } finally {
      setSending(false)
    }
  }

  async function cancel() {
    try {
      await cloudApi.cancelLogin(login.login_id)
    } catch (err) {
      notifyError(messageOf(err, "Could not cancel the Yaran Cloud login."))
      return
    }
    onCancelled()
  }

  return (
    <form onSubmit={finish} className="flex flex-col gap-3">
      <DialogDescription>
        Approve this machine for <InlineCode>{login.org_name}</InlineCode> in the
        browser tab that opened. Check your browser shows the same code:{" "}
        <InlineCode>{login.fingerprint}</InlineCode>
      </DialogDescription>
      <p className="text-sm text-muted-foreground">
        No tab? Open <InlineCode>{login.authorize_url}</InlineCode> on any
        device.
      </p>
      <Button
        type="button"
        variant="outline"
        className="self-start"
        onClick={() => openInNewTab(login.authorize_url)}
      >
        <ExternalLink />
        Open the approval page
      </Button>
      <p className="text-sm text-muted-foreground">
        If the browser is on another device, it cannot reach this machine after
        you approve. Paste the address it lands on here:
      </p>
      <Input
        aria-label="Landing address"
        placeholder="http://127.0.0.1:…/callback?code=…"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        disabled={sending}
        aria-invalid={error !== null}
        aria-describedby={error ? "cloud-paste-error" : undefined}
      />
      {error ? (
        <p id="cloud-paste-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => void cancel()}>
          Cancel login
        </Button>
        <Button type="button" variant="outline" onClick={closeCloudDialog}>
          Close
        </Button>
        <Button type="submit" disabled={sending || !address.trim()} aria-busy={sending}>
          {sending ? <Loader2 className="motion-safe:animate-spin" /> : null}
          Finish
        </Button>
      </DialogFooter>
    </form>
  )
}

function PairedView({
  status,
  acting,
  onRotate,
  onDisconnect,
}: {
  status: CloudStatus
  acting: boolean
  onRotate: () => void
  onDisconnect: () => void
}) {
  const leg = status.leg
    ? `${status.leg.state} (since ${status.leg.since})`
    : "not running (it starts while yaran serves)"
  return (
    <div className="flex flex-col gap-3">
      <DialogDescription>
        This machine is paired with{" "}
        <InlineCode>{status.org_name ?? status.org_url ?? ""}</InlineCode>.
      </DialogDescription>
      {status.revoked_at ? (
        <p role="alert" className="text-sm text-destructive">
          The control plane revoked this machine. Disconnect, then connect again
          to restore remote access.
        </p>
      ) : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Machine</dt>
        <dd>
          <InlineCode>{status.hostname ?? ""}</InlineCode>
        </dd>
        <dt className="text-muted-foreground">Owner</dt>
        <dd>
          <InlineCode>{status.owner_email ?? ""}</InlineCode>
        </dd>
        <dt className="text-muted-foreground">Tunnel</dt>
        <dd>{leg}</dd>
        <dt className="text-muted-foreground">Mode</dt>
        <dd>{status.mode}</dd>
      </dl>
      <DialogFooter>
        <Button variant="outline" disabled={acting} onClick={onRotate}>
          Rotate token…
        </Button>
        <Button variant="outline" disabled={acting} onClick={onDisconnect}>
          Disconnect…
        </Button>
        <Button variant="outline" onClick={closeCloudDialog}>
          Close
        </Button>
      </DialogFooter>
    </div>
  )
}
