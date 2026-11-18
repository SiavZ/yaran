# Mobile shell parity: implementation and validation ledger (track C)

Scope: the phone app's bundled shell (`mobile/app/**`) for G1 (direct machines), G2 (routes),
G5 (share target) and G6 (verified agent links), plus two shell findings from Sol review
round 1. It builds against the frozen contract in `mobile-parity-contracts.md` and uses its
exact plugin and protocol types. Date: 2026-11-17. Values someone else supplies are written as
`<publisher-domain>`, `<org-control-plane>` and `<machine-host>`.

Everything below is the shell only. Nothing here was run on a phone. Every native call the
shell makes for G1, G2 and G5 is exercised against mocks of the contract types as they stand
now: `directStatus`, `directSignIn`, `directSignOut`, `routeStatus`, the `direct` and `routes`
open forms, `share`, `shareStatus`, `discardShare` and `shareReceived`. Where a native build
does not implement one of them yet, the shell shows the native refusal with its code rather
than opening or saving anything. Section "Native dependency still owed" lists what is left.

## What the shell now does

### G1: direct machines

| Piece | File | Behaviour |
|---|---|---|
| Entry | `screens/onboarding/EnterUrl.tsx` (`machine` mode, route `enter-machine`), `Welcome.tsx`, `MachineList.tsx` "Add a machine" | A typed address gets `https://` when no scheme is typed, then the host rules: HTTPS only, default port, no path, no IP literal, no IDN. Each refusal has its own machine sentence (`lib/orgUrl.ts` `machineRefusalMessage`). |
| QR and link | `ScanQr.tsx`, `lib/deepLinks.ts` | `yaranapp://add-machine?u=…` (parsed with `parseAddMachineUri`) only pre-fills Confirm machine. Parse order: add-machine, then agent link, then `parseAppUri`. |
| Confirm | `screens/onboarding/ConfirmMachine.tsx`, `screens/machines/DirectCheck.tsx` | Re-checks the host with `isPublicHost`, shows it as a chip with the links-can-come-from-anyone warning, loads every org list that has never answered, and runs the known-host guard. Only then does it call `Session.directStatus` and show the identity (`instance`, or a sentence when it is null), whether the last hop is encrypted (`transportEncrypted`), and the password sentence (none needed, sign in once, already signed in, or "set a password first" with no add). Add needs a press. |
| Sign-in | `DirectCheck.tsx`, `directText.tsx` | When `requiredHere && !signedIn`, the add runs `Session.directSignIn` first (the native sheet; the password and token never reach JS). Every `DirectSignInOutcome` has a sentence; the machine's own `message` renders as text. Try again shows only where it can help, and a `rate_limited` answer disables it for `retryAfterSeconds`. A sign-in that answers as a different instance than the probe is signed out again and nothing is added. When saving fails after a sign-in this flow made, that session is ended again, and the real rejection code is shown. |
| Persistence | `lib/directStore.ts` | Vault namespace `direct`, key `list`, class `standard`: `{id, label, host, instance, addedAt, routes}` only. Malformed records (bad host, a route list without the record's own host, duplicate hosts, extra fields on a direct route, more than `MAX_ROUTES`) are dropped loudly. |
| List | `screens/machines/DirectSection.tsx` | A "Direct" section after the org sections, with a note that direct machines get no notifications. Each row opens the machine, and its `⋯` holds Open, Sign in again…, Ways to reach it… and Remove…. |
| Remove | `DirectSection.tsx`, `directStore.removeDirect` | A destructive confirm (Cancel autofocused, name as a chip). It runs `Session.directSignOut` for every direct route host, then forgets the record and the last-machine setting. `vault_locked` or a rejection keeps the record and says so. The toast says whether the machine confirmed ending the session (`serverEnded`). |
| Last machine | `lib/settingsStore.ts`, `lib/lifecycle.ts` | `lastMachine` is either the old org shape (unchanged, so saved settings still load) or `{directId}`. Reopen-last-machine opens a direct record through `openDirect`. |
| Instance changed | `App.tsx`, `screens/machines/InstanceChangedDialog.tsx` | A window closing with `{reason:"error", code:"instance_changed"}` raises a dialog for the last direct machine opened. Not now (autofocused) changes nothing. Keep re-reads `directStatus`, stores the instance it reports now, and opens again. Remove signs out and forgets. |
| Erase everything | `lib/orgStore.ts` `eraseEverything` | Runs `directSignOut` for every direct host (best effort, one failure does not stop the rest) before `SecureStore.eraseAll`, then resets the direct list. Org sign-out never touches direct sessions. |

### G2: routes

- `screens/machines/MachineRoutes.tsx` (route `machine-routes?id=`) lists the record's routes in
  the order native tries them. Move up and Move down reorder; Remove drops an alternative (a
  typed one is signed out natively first, and a failed sign-out keeps the route). The machine's
  own address cannot be removed here. At most `MAX_ROUTES`.
- A typed alternative goes through the same host rules and the known-host guard, then
  `DirectCheck` with `expectInstance`: it must answer `directStatus` as the record's instance,
  and it signs in on its own when it needs a password.
- An org machine this phone already lists can be added as a route only after it is checked
  (`MachineRoutes.tsx` `addCheckedOrgRoute`):
  1. `Session.routeStatus({route})` probes that host with its own org session only.
  2. On `sign_in_required`, `Session.signIn({orgId, target: {machineHost}})` runs, then the
     route is probed again.
  3. It must answer as the record's instance. Any sign-in failure, a second
     `sign_in_required`, a probe failure or rejection, or another instance saves nothing.
  4. After the awaits, the record is re-read. The route is refused if, meanwhile:
     - the record was removed
     - its instance changed
     - the route cap filled
     - the host or org machine is already a route
     - the org was signed out, or its list no longer has the machine at that host

  Nothing is saved on the user's word. Native still checks every route again at each open.
  Typed routes also re-read the record, including its instance, before saving. Move and
  Remove work from the current record, so a stale screen cannot write back an old list.
- A record whose instance is null cannot get alternatives, because nothing could check them.
- `lib/openMachine.ts` `openDirect` sends `{kind:"routes", routes, instance}` when more than one
  route remains and the instance is known, and `{kind:"direct", host, instance?}` otherwise. Org
  routes are re-resolved against the current org list at every open: a route through an org
  this phone left, or to a machine its list no longer has, is dropped, and a listed machine's
  current hostname replaces the stored one. Signing out of an org removes its routes from every
  direct record (`forgetOrgRoutes`). A window closing with `no_route` raises a toast.

### Known-host guard

`lib/knownHosts.ts` answers who owns a host, by exact comparison: an org's control plane, an org
machine in a loaded list, or any route of a direct record. Confirm machine and Ways to reach it
refuse an owned host before probing it. `openDirect` refuses (`host_conflict`) a record whose own
host an org now lists, because an org sign-out would wipe that host's web data. The native
`refused {reason:"org_host"}` answer (a host with an org session record) is the second authority
and has its own sentence, which also covers an org list that could not load.

### G5: share target

- `lib/share.ts` keeps `shareStore` (`ShareStatus` or null) and reads `MachineView.shareStatus`
  as the truth. The `shareReceived` listener (`lib/lifecycle.ts`) treats `files` as "look again";
  when the pull rejects (an older native), the event's count stands in. `refused` raises one
  sentence for `no_files` and one for `unsupported_os`, and `dropped > 0` raises a warning.
- Cold start: `startUnlocked` (App, when not locked) shows the share screen when files are
  waiting, and in that case does **not** reopen the last machine over it. After an unlock,
  `afterUnlock` checks again. Navigating to `#/share` twice is a no-op, so a retained event plus
  the pull lands once.
- `screens/machines/ShareTarget.tsx` shows "Send N files to…" with every org machine (loading
  lists that never answered) and every direct machine. A pick calls `open(…, share: true)`.
  `no_share` re-reads the status and says the files are gone. "Cancel and discard" calls
  `discardShare`; a rejection keeps the files and says so. JS never sees a URI, a name or bytes.
  Attaching stays in the page's own file chooser, so web ownership, the upload and its toast
  are unchanged.

### G6: verified agent links

`lib/deepLinks.ts` `openAgentLink(url, publisherDomain)`:

- The domain comes from `Session.callbackMode()` through `loadBuildInfo`. A `dev` build passes
  `""` and every link is refused with a sentence saying this build cannot open them.
- `parseAgentLink` is strict, and the ids become the route through `agentRoute`, so `/` and `#`
  in an id stay encoded.
- An org target must match an added org's `id` exactly. When its machine is not in the loaded
  list, the list is refreshed first. If the refresh fails, the sentence says the list could not
  load, rather than that the machine is unknown.
- A direct target must match a stored direct host (the record's own host or a direct route).
- Nothing is ever added from a link. An unknown target gets "That link is for a machine this
  phone hasn't added." and the Machines screen.
- A link arriving while the app is locked is held, and so is one arriving while the lock state
  cannot be read. The toast "Unlock yaran to open that link." shows once, and the link (the last
  held one) opens once after unlock. The lock screen's Unlock and native's `lockStateChanged`
  both release it, and the second release is a no-op.

### Launch ordering

`App.tsx`, `lib/lifecycle.ts` and `lib/deepLinks.ts`:

- The lock state is read at once, so the lock screen never waits on a slow launch URL.
- Every incoming link (the launch URL and later `appUrlOpen`) runs on one queue, in order.
  `links.settled()` resolves once all links so far are handled, with whether any claimed the
  launch. A navigated, refused or held link claims it; `reauth` and no link do not.
- An unlocked start runs these steps in order:
  1. Release a held link.
  2. Await `settled()`. If a link claimed the launch, stop.
  3. Otherwise `startUnlocked`: a waiting share wins, then a Confirm org or Confirm machine
     screen already on show stays, and only then is the last machine reopened.
- A locked or unreadable lock state opens nothing by itself.
- All of this state lives in one `installDeepLinks` call (no module globals) and dies with the
  mount's teardown:
  - a held link is dropped
  - a link mid-way stops before it opens
  - `startUnlocked` and `reopenLastMachine` check `alive()` after each await

  A later mount, and later links or shares, behave normally. The `closed` listener is now
  removed on unmount too.
- `launch.test.tsx` drives the real App:
  - a deferred launch URL, build facts, lock state and machines list: the last machine never
    opens ahead of the agent link, and only the linked machine opens
  - add-org and add-machine launch links keep their Confirm screen
  - unmounting during the launch URL, and during the reopen's list load, opens nothing
  - with no link, the last machine reopens and a later link still opens
  - a link in one launch does not stop the next launch from reopening
  - a waiting share wins, and a later share still shows
  - a locked launch link opens exactly once after Unlock plus `lockStateChanged`
  - an unreadable lock state reopens nothing

  Removing the `settled()` check, or the `alive()` check after the reopen's list load, makes
  these tests fail; both were tried.

## Sol round 1 shell findings

| Finding | Fix | Regression |
|---|---|---|
| (2) A failed open from a notification tap was logged, and `handleTap` still cleared the delivered alerts. | `TapDeps.openAgent` resolves `boolean`. The adapter in `push/pushWiring.ts` logs the failure, raises `openFailureMessage` as an error toast, and returns false. `handleTap` returns `open_failed` and clears deliveries only after a successful open. | `pushWiring.test.ts` drives a native `MachineView.open` rejection through the real `notificationTapped` listener, adapter and `handleTap`: a toast with the code, no `clearDelivered`; the next successful tap clears. `notificationTap.test.ts` covers `open_failed`. |
| (3) A failed refresh restored the list captured when it started, which brought back a machine `dropMachine` had removed while the call was in flight. | `refreshMachines` keeps the list as it is at the end on failure. The in-flight cleanup and the org-removed check are unchanged. | `machinesStore.test.ts`: a deferred refresh, a drop, then a failure (and a rejection) keeps the machine dropped and lets the next refresh run. |

`secure_storage_failed`, now in `SignInOutcome`, `DirectSignInOutcome` and
`DirectSignOutOutcome`, has its own sentence in `SignInResult.tsx` and `directText.tsx`
(storage, never "locked") with Try again. A direct sign-out that answers it keeps the record
(Remove, and removing a route), so the native session record is never orphaned.

The shell also stopped mislabelling failures. A vault write that fails while staging an org for
sign-in used to show "Unlock the app first", and a rejected `Session.signIn` used to show "No
connection". Both now show the real rejection code (`SignInResult`'s shell-only `rejected`
case). The direct flows follow the same rule. `onboarding.test.tsx` covers it.

## Sol round 2 shell findings

| # | Finding | Fix | Regression |
|---|---|---|---|
| 1 (P1) | `instance_changed` was tied to the last direct machine opened, so A then B then a late close for A named and removed B. | `openMachine.ts` `instanceChangedTarget` uses the close event's own `host` and `requestedHost`. Both must be addresses of one record (stored routes, or org routes re-resolved), and of exactly one. Anything else raises a warning toast and no dialog, so nothing destructive is offered. The global `lastOpenedDirect` is gone. Keep re-probes the changed route with `routeStatus` (its own credential). | `instanceChanged.test.tsx`: open A, then B, then a close for A names and removes A, never B; a close on an alternative route reaches the record owning both hosts; no context, only a host, hosts of two different machines, and an unknown host each show the warning, no dialog, and both records stay. |
| 2 (P1) | A sign-in still pending when Confirm machine unmounted, or when Erase everything ran, recreated `direct/list`, toasted and navigated. | `DirectCheck` cancels its approval on unmount and when the catalog generation moves (Erase everything bumps it). It checks after every await and passes `cancelled` to `onApproved`. `addDirect` and `updateDirect` re-check it when the write's turn comes. An abandoned or failed approval ends the session it minted only while it is still the newest approval on that host and no saved machine owns the host, so it never deletes a newer approval's sign-in. Erase closes the catalog first (`closeCatalogForErase`): writes queued or running before it are refused with `erased` and cannot land after the wipe. | `direct.test.tsx`: unmount during the sign-in leaves no record and no navigation, and ends that session; Erase during the sign-in recreates nothing and ends it; an older abandoned approval does not sign out a newer one on the same host. `directStore.test.ts`: a running and a queued write both reject with `erased`, and memory and vault stay empty. |
| 3 (P2) | The root teardown came too late: a valid launch link resolving after unmount opened before `installLifecycle` returned, and StrictMode duplicated it. | The mount's liveness passes into `installLifecycle(onLock, mounted)` and `installDeepLinks(mounted)` at call time. It is checked before every step and side effect. A listener whose registration finishes after unmount is removed at once. `routeToPendingShare(alive)` and `onShareReceived(e, alive)` do not navigate after teardown. | `launch.test.tsx`: a valid agent link resolving after unmount opens nothing; under StrictMode a launch link opens once; a pending-share pull answering after unmount does not navigate. Removing every mount check in the link path makes the first test fail (tried). |
| 4 (P2) | A `content:` or `file:` launch URL (a share) warned "isn't a yaran link" and claimed the launch, so the pending-share check was skipped. | Both schemes are ignored with no toast and no log, and do not claim the launch. Malformed `yaranapp:` and `https:` links still warn. | `launch.test.tsx`: each scheme plus a pending share lands on the share screen with no warning and no reopen. Removing the check fails both cases (tried). |
| 5 (P2) | Overlapping catalog writes lost changes or restored removed routes, and memory diverged from the vault. | `directStore` runs one write at a time (`mutate`). Each change is computed from the catalog as it is when its turn comes; it is validated, written, and only then shown. `updateDirect(id, change)` takes a function, and Ways to reach it uses it for move, remove, typed add and the checked org add. Only one route action runs at a time on that screen; the other buttons are disabled meanwhile. | `directStore.test.ts`: an overlapping remove and reorder of one record both land in memory and on disk; changes to two records at once keep each other; a failed write changes neither memory nor disk, and the next write still runs. |
| 6 (P2) | The same launch URL from `getLaunchUrl` and `appUrlOpen` opened twice. | `appUrlOpen` is registered before the launch URL is read, so nothing is missed meanwhile. One cross-delivery twin within `STARTUP_TWIN_MS` (3 s) is dropped, once, in either order, for that install only. A later deliberate tap of the same URL opens. | `launch.test.tsx`: launch URL first, and `appUrlOpen` first: one open each, then a later tap opens again. Removing the suppression fails the test (tried). |
| 7 (P2) | Remove: when native sign-out succeeded but the vault write then failed, it threw with no toast. | `removeDirect` returns `{kind: "failed", code, signedOut: true}` with a sanitized code. Both dialogs say the phone signed out but the machine is still listed. | `directStore.test.ts`: a native sign-out followed by a rejected write gives `signedOut: true` and code `unknown`, and the record stays in memory and on disk. |
| 8 (P2) | Two individually valid records sharing a host or an id: removing one signed the other out, and lookups took the first. | Records sharing an id or any route host are rejected when the catalog loads, logged with a count and no hosts. Nothing is merged and no session is touched. Every catalog write runs the same check and refuses with `conflict`. | `directStore.test.ts`: records sharing a route host and records sharing an id are all rejected, with no sign-out and no lookup hit; a change that would create a conflict, and adding an existing host, are both refused. |
| 9 (P2) | A successful refresh sent before `dropMachine` brought the machine back, and a refresh asked for after the drop joined the old request. | Each running request records the ids dropped while it was out and filters them from its own answer only, so there is no lasting tombstone. A refresh asked for after a drop waits for a fresh request, shared by later callers, instead of joining the stale one. | `machinesStore.test.ts`: a deferred successful refresh after a drop leaves it dropped; a refresh asked for after the drop makes a third request, and a machine the server lists again shows up. |

## Sol round 3 shell findings

| # | Finding | Fix | Regression |
|---|---|---|---|
| 1 (P1) | `closeCatalogForErase` only bumped a counter. A change started while the vault wipe was pending was accepted, so erase ended with an empty list in memory but records on disk. | `directStore.eraseDirect(wipe)` closes the catalog and direct sign-in to anything new, including during the wipe. It drains the catalog queue and every same-host turn already queued or running (each sees the erase and cleans up in its own turn), signs saved machines out, runs the wipe, empties the list, and reopens only after that, in `finally`. A failed wipe reopens and rejects. `orgStore.eraseEverything` runs entirely inside it. | `directStore.test.ts`: in each phase (a write already running drains, saved machines are signed out, the vault wipe runs), an add, an update, a remove and a sign-in are all refused, erase has not resolved yet, it ends empty on disk and in memory, and a later add works; a failed wipe reopens. |
| 2 (P1) | An approval cancelled while `SecureStore.set` was out still saved. | `mutate` checks the approval's own `cancelled` (and the erase generation) before the write and again after it. A cancelled write is undone inside the same turn by writing back the catalog as it stood just before, so changes to other records are kept. If the undo fails, the written catalog is what is shown and the change rejects with `rollback_failed`, so the machine stays listed and its session stays. `addDirect` and `updateDirect` take the predicate, and the typed route add passes it. | `directStore.test.ts`: write held, abandoned, then released: neither disk nor memory has it, and the other record stays; the same with an erase instead; a failed undo rejects `rollback_failed` and memory equals disk. `approval.test.tsx`: leave Confirm machine while its save is being written: nothing saved, no toast, no navigation. |
| 3 (P1) | The newest-approval marker couldn't own host-wide native sign-out. A abandoned, B started and cancelled, then A returned and its session was never cleaned up; A could also finish after B and an erase. | The marker is gone. `withHost(host, job)` runs every shell `directSignIn` and `directSignOut` one at a time per host: an approval's whole sequence, Sign in again, removing a route, and Remove. An approval's sign-in, save and clean-up all happen inside its own turn, so the next same-host sign-in starts only after the session it minted is saved or ended. Clean-up skips a host a saved machine owns, which includes a record kept by a failed undo. Erase refuses new turns and waits for the running ones. | `approval.test.tsx`: B signs in only after A's clean-up (in, out, in); A abandoned, B abandoned before its turn, A returns: A cleans up and B never signs in (in, out); A pending, B queued, erase: A cleans up, B never signs in, and the wipe comes last (in, out, erase); erase waits for an open sign-in, refuses new turns, and reopens afterwards. |
| 4 (P2) | Keep probed the org route's old host and saved that answer, while the open resolved the machine's new host. | `openMachine.currentRoute` re-resolves the route by identity (the org machine, or the direct host) against the current org lists. Keep probes that, then checks again inside the queued identity write, and refuses with "That way to reach the machine changed while the app was checking it" if the route is gone or its host changed. | `instanceChanged.test.tsx`: a machine moved to host B before Keep is probed at B, never A; a route that moves host, is removed from the record, or leaves its org list while the probe waits saves nothing and opens nothing. |
| 5 (P2) | The lock listener was registered after the slow launch URL, so an unlock on the lock screen while the install was pending reached nobody, and the install then decided on the old locked status, stranding the held link. | `installLifecycle` registers the lock listener first. The App reads the lock state again once the install finishes and decides on that. If it was unlocked meanwhile, `afterUnlock` releases the held link and checks for a share. Locked or unreadable opens nothing. A later native unlock event releases nothing twice. | `launch.test.tsx`, through the real App and lock screen: start locked, a link is held during a deferred launch URL, Unlock is pressed before the install finishes, and the link opens exactly once (a native unlock event afterwards adds nothing); an unreadable lock state at the end opens nothing; leaving before the install finishes opens nothing and removes the lock listener. |
| 6 (P2) | An org removed and added again could join the old request, whose late `device_revoked` then removed the new org. | Each org's list has an incarnation number that `forgetOrgMachines` and `resetMachines` move on. A refresh joins only a request of the current incarnation. A request of an old one delivers nothing (no list, no failure, so no `device_revoked`), and its queued follow-up does not run. Dropped-machine filtering and the fresh request after a drop are unchanged. | `machinesStore.test.ts`: remove and re-add the same URL while the old request is out: the new refresh sends its own request; the old one answering `device_revoked`, an error, or another list after the new one returns null and leaves the new list alone; a follow-up queued by a drop on the old org never sends a request; a reset retires requests the same way. |

Mutation checks for round 3, each restored and compared afterwards. Every one fails its tests:
- catalog not closed: 7 failures
- no undo after the write: 3 store failures plus 1 screen failure
- `withHost` not serialized: 1 failure
- no recheck inside the Keep write: 3 failures
- Keep probing the old route: 1 failure
- deciding on the start-up lock read: 1 failure
- no incarnation check: 3 failures

## Sol round 4 shell findings

Base: main at `a3acc113f` (PR #127 merged, its UI kept). New shared helper: `lib/erasure.ts`,
one coalesced erase barrier and epoch that both stores read.

| # | Finding | Fix | Regression |
|---|---|---|---|
| 1 (P1) | Two erases at once: B finished first, reopened the catalog, and an add then landed after A's wipe. | `runErase` coalesces: Erase while one runs joins the same promise, so only the owner reopens, after its wipe settles. `directStore` and `orgStore` read the barrier (`erasing()`) and its epoch instead of their own flags. | `directStore.test.ts`: A's wipe held, B joins, an add in between is refused, the vault is wiped once, both end empty on disk and in memory, and an add afterwards works. |
| 2 (P1) | A Sign in again queued behind Remove minted a native session with no metadata, because the removal's commit was outside the host turn. | `removeDirect` holds every direct host's turn (taken in a fixed order) across the native sign-outs and the catalog commit. Sign in again re-reads the machine inside its own turn and signs nothing in when it is gone ("was removed from this phone"). | `direct.test.tsx`, through the real menu: Remove first means the queued Sign in again never reaches native; Sign in again first means the queued Remove ends that session too (in, then out). `directStore.test.ts`: the same with the store calls, and a failed commit keeps the record the later sign-in belongs to. |
| 3 (P1) | An abandoned approval's clean-up ignored native failures, stranding a token with no metadata. | The clean-up reads every outcome: `signed_out`, `not_current` and `refused` leave nothing behind. On a real failure (`secure_storage_failed`, `vault_locked`, a rejection), the machine is listed after all, so the session has a row to Remove from, and a sticky global toast says so even after the screen is gone. If listing fails too, a second toast points to Erase everything. During an erase nothing is listed: the erase owns the list and its wipe removes the session locally. The clean-up passes its own `signInId` (live contract), so a newer sign-in on the host answers `not_current` and stays. | `approval.test.tsx`: a failed clean-up lists it with a toast carrying the code; `not_current` lists nothing; during an erase nothing is listed and it ends empty; a save undone after leaving, then a failed clean-up, lists it on disk and in memory; and the A-shell/B-window regression below. |
| 4 (P1) | Confirm org's rollback restored an org that Erase everything had removed. | Staging and restoring carry the erase epoch they started in (`addOrg(…, asOf)`). Org writes go through one serialized queue that refuses a write from an older epoch, and erase drains that queue before its wipe. After an erase, a failed sign-in restores nothing; a success neither re-adds nor navigates; and nothing navigates after the screen is gone. | `onboarding.test.tsx`: a cancelled, failed or successful sign-in that ends after an erase leaves the list empty on disk and in memory, and stays on the screen; after the screen is gone a failure still removes its staged org and a success navigates nowhere. |
| 5 (P1) | A device_revoked cleanup, or a push reconcile, from before an erase removed the org added again since. | Each org has an incarnation (`orgIncarnation`). `removeOrgLocal`, `handleDeviceRevoked`, `signOutOrg`, `onOrgFailure` (with the incarnation captured before the request, Remove machine's included) and every push `record` caller check it before each destructive step and after each await. A stale answer is dropped: no push state, no toast, no navigation, no native sign-out. | `pushWiring.test.ts`: a device_revoked whose clean-up was held, then erase and re-add: the new org stays and nothing navigates; a revoked push answer for the old incarnation leaves the new org, its push state and its native sessions alone; the same answer for the current incarnation still removes it. |
| 6 (P2) | A late first lock read overrode a newer `lockStateChanged(true)`, and a final read of locked returned without showing the lock screen. | Lock events (native, and Unlock on the lock screen) bump a counter. A read counts only if no event arrived while it was out, and a counted read is shown at once, a lock included, before any early return. Locked or unreadable opens nothing. | `launch.test.tsx`: a late unlocked first read after a lock event, with the final read still out, keeps the lock screen; a final read of locked after an unlocked start shows the lock screen and opens nothing, also under StrictMode; an unreadable final read opens nothing. |
| 7 (P2) | Keep overwrote an identity a newer Keep had already accepted, and committed an old host's answer after an org remap during the write. | The close target pins the identity it replaces (`ChangedTarget.instance`). Keep proceeds, and its queued write commits, only while the record still has that identity and the route still resolves to the probed host. The same check runs again after the durable write and undoes it if either moved. | `instanceChanged.test.tsx`: a newer Keep that saved `inst-2` wins over an older one answering `inst-3`; a route that moves host, or leaves its org list, while the identity is being written is undone on disk and in memory and not opened. |
| 8 (P2) | Releasing a held link skipped a fresh lock check: a relock while it waited on build info, or a native `vault_locked`, consumed the link. | Release and a new link take the same `attempt` path: the lock is read first and again right before the native open (`mayOpen`). A relock, or a `vault_locked` answer, holds the link again. Exactly one link is held, the latest. | `deepLinks.test.ts`: relocked while the release waits on build info, kept, then opened once on the next unlock (a second release is a no-op); `vault_locked` keeps it with no error toast, and the next unlock opens it once; a later link replaces the held one. |
| 9 (P2) | A failed undo (`rollback_failed`) was hidden by the abandoned early return. | The global toast comes before that return. It names the code and says the machine stays listed with its sign-in, and nothing signs that session out, because the listed machine owns it. | `approval.test.tsx`: unmount while the save is held, then the save lands and its undo fails: a toast with `rollback_failed`, the machine listed, no sign-out. |

**A-shell/B-window regression (live `signInId` contract).** `approval.test.tsx` uses a fake
native host that follows the contract: a sign-in replaces the host's current session, and a
sign-out with an id that is not current touches nothing and answers `not_current`.
- Shell approval A is abandoned, and the machine window's own sign-in B replaces A before A's
  clean-up runs. A's clean-up sends `{host, signInId: 'shell-1'}`, B's session stays current,
  nothing is listed and no error is shown.
- With no other sign-in on the host, A ends exactly its own session.

**Mutation checks for round 4.** Each was restored and compared afterwards, and every one fails
its tests:
- erase not coalesced: 1 failure
- no revalidation in Sign in again: 1 failure
- clean-up outcome ignored: 2 failures
- clean-up without `signInId`: 6 failures
- Confirm org rollback with both fences removed: 2 failures
- push `record` without the incarnation check: 1 failure
- removal with every incarnation check removed: 1 failure
- a read overriding newer lock events: 1 failure. The test first passed under this mutation
  because the final read re-locked the screen; it now holds the final read open.
- Keep without the identity pin: 1 failure
- Keep without the post-write check: 2 failures
- release without the lock check before open: 1 failure
- `vault_locked` not kept: 1 failure
- no rollback toast: 1 failure

Two of these needed both layers removed: the Confirm org rollback (the erase check, and the
epoch fence on the write) and the org removal (the checks between the awaits, and the check
inside the write). Removing either layer alone passes, because the other one catches it.

## Sol round 6 shell findings (frozen review, base a3acc113)

| # | Finding | Fix | Regression |
|---|---|---|---|
| 1 (P1) | When an org claimed the host while a direct sign-in was out, Confirm machine returned normally. DirectCheck took that as done and skipped the clean-up, stranding the session: a warning, no record, no sign-out. | Confirm machine turns a claimed host into a refusal (`host_owned`), so DirectCheck's existing clean-up runs and ends exactly the sign-in it minted (`directSignOut({host, signInId})`). A newer sign-in, the window's say, answers `not_current` and stays. The claim is checked again after the durable save and undoes it. Ways to reach it does the same for a typed route. | `approval.test.tsx`: an org claims the host during the sign-in: one `directSignOut` with the approval's own id, nothing listed, and the owner named; the window's newer sign-in answers `not_current` and stays current, with no error; an org claims the host while the save is written: the save is undone on disk and in memory, and its own sign-in ended. |
| 2 (P1) | Push orchestration deleted native push keys (`forgetOrg` on a revoked answer) before `record`'s incarnation check. A late `device_revoked` after an erase and re-add destroyed the new org's push keys. | `scopedPushDeps(live)` in `pushDeps.ts` checks the captured incarnation before every native push call and every org request, so work that awaited across a removal stops before it forgets, registers, mutes or deletes anything. Every push entry point uses it: reconcile, drain (per org), turn on, turn off, mute, mute machine. `unregisterOrgPush(id, live)` takes the same check, sign-out passes its incarnation, and its final push-state delete is guarded too. Offline mute patches (`muteSync`, now in `pushDeps.ts`) are forgotten with the org and on erase, so an old patch never reaches a re-added org's device. | `pushWiring.test.ts`: the device-list request held, erase, re-add with replacement push state, then `device_revoked`: no `forgetOrg`, the replacement state and the org survive; a sign-out whose unregister waits while the org is replaced calls neither `forgetOrg` nor `Session.signOut`, and leaves the new push state; the current incarnation's revoked answer still calls `forgetOrg` and removes the org. |
| 3 (P2) | `updateSettings` wrote a whole snapshot outside the erase barrier, so a held settings write brought back the last machine (an org URL and host) and the reopen preference after the wipe. | Settings writes go through one queue inside the same barrier: refused while an erase runs, computed from the settings when their turn comes, and fenced by the erase epoch (a write from before an erase neither shows nor survives it). Erase drains the queue before its wipe. The forget-the-last-machine helpers decide in their own turn. | `settingsStore.test.ts`: a held write and a queued one across an erase: the erase waits, a write during it is refused, both stale writes reject, vault and memory end at the defaults, and a later write works; a write that fails while the erase drains it does not strand the barrier; forgetting the last machine respects a newer choice. `pushWiring.test.ts`: the erase waits for a device_revoked clean-up it overlaps. |
| 4 (P2) | `openAgentLink` opened the machine after its last lock read without checking the shell was still mounted. | The mount is checked again right after that await and before the native open, for org and direct targets alike. Relock and `vault_locked` retention, open-once on unlock and the startup twin are unchanged. | `deepLinks.test.ts`: for an org machine and for a direct machine, the link wiring is removed while the last lock read is held, then the read answers unlocked: no open. |

**Adjacent call sites checked:**
- Every push entry point that reaches native or the org's API, and the unregister used by
  sign-out and erase. The scoped deps also cover `MuteSync.apply` and `flush`.
- Every `updateSettings` caller: open, the Settings toggles, Language, and the
  forget-last-machine helpers in org and direct removal. The Settings and Language toggles
  still fire and forget, as before: a write refused during an erase is not reported there.

**Mutation checks for round 6.** Each was restored and compared afterwards, and every one fails
its tests:
- a quiet return on a claimed host: 2 failures
- no post-write claim check: 1 failure
- scoped deps that never refuse: 2 failures
- unregister unscoped in sign-out: 1 failure
- erase not draining settings: 3 failures
- settings writes not fenced by the epoch: 1 failure
- no mount check after the last lock read: 2 failures

**Headers.** Checked with every untracked file in the repository included through a temporary
index (`GIT_INDEX_FILE`; the real index untouched), the same view the root used for its 22
derived updates. The shell files were regenerated, and so were the "Used by" trees of
`cloud/protocol/src/index.ts` and `mobile/plugins/secure-store/src/index.ts`, which my new test
imports made stale; the diff shows exactly one header tree line changed in each. The
repo-wide `--check` then reports only `NativeHttp.kt` and `OrgApiClient.kt` in the
machine-view plugin, which are native files outside shell scope. `--lines --check` passes
repo-wide.

## Sol round 7 shell findings (frozen review of 441 tests, base a3acc113)

Each fix carries the same stale-operation context through every await, memory change and
native call, using the existing org incarnation and the erase barrier.

| # | Finding | Fix | Regression |
|---|---|---|---|
| 1 (P1) | A Turn off whose metadata request was held across an erase reached `Session.installId`, which mints the org's install id and device key, before the scoped registration refused. | Push work takes a ticket when it starts: the org's incarnation and the erase epoch. `pushOrgOf` checks the ticket before `Session.installId` and again after it. Turn on checks it after the permission prompt, before anything else. The scoped deps, `record`, the mute toasts and the turn-off toast all use the ticket. Drain leaves out an org whose ticket went stale rather than failing the rest. | `pushWiring.test.ts`: Turn off with its metadata held across an erase, across a sign-out, and answering while an erase is still running with the org still listed; Turn on with its permission prompt answered after an erase, and after a sign-out. In each: no `Session.installId`, no `Session.deviceKey`, no `registerDevice`. Control: current Turn on asks for the install id and registers. |
| 2 (P2) | A mute PATCH answered after an erase and re-add still changed `MuteSync`'s pending map (set on offline, delete on success or revoked). The new org's next reconcile then sent the old `mute_all: true`. | `scopedPushDeps` exposes its `live` check on the deps (`PushDeps.live`). `MuteSync.apply` checks it as soon as the answer arrives, before the pending patch is set, replaced or deleted, and stops (`StalePushOrg`, which now lives in `pushRegistration.ts`). The pending map is still forgotten with the org (`removeOrgLocal`) and on erase. | `pushWiring.test.ts`: a mute answered offline, success or revoked after an erase and re-add leaves the new org's own pending patch as it saved it; the next flush sends that patch, never `mute_all: true`; no `forgetOrg`. Control: a current offline answer is still kept. |
| 3 (P2) | Confirm org's failed re-sign-in restored the previous org with no check, so it undid a sign-out made meanwhile, or overwrote an org added again with the old name and team. | `orgStore.restoreOrg(previous, inc, asOf)` decides inside the org write queue: it restores only while the org is still the staged incarnation, and not after an erase. Confirm org uses it, and still removes a newly staged org with `removeOrgLocal(id, staged)`. | `onboarding.test.tsx`: sign-out while the sign-in is pending, then cancelled or failed: nothing comes back, on disk or in memory, and nothing navigates; sign-out and re-add, then cancelled: the new name and team stay; the sign-out's removal write still queued when the result arrives: nothing is restored; control: a failed re-sign-in that still owns its staging restores the previous org. Erase retention stays covered by the round 4 tests. |

**Mutation checks for round 7.** Each was restored and compared afterwards, and every one fails
its tests:
- install id not fenced: 2 failures
- a ticket that ignores the erase epoch: 4 failures. This passed until I added the "erase still
  running" case: the other cases resolve after the erase has finished, when the incarnation is
  already gone.
- the permission path with both fences removed: 4 failures
- the mute answer not checked before the pending map: 3 failures
- restore without the staged incarnation: 3 failures
- Confirm org back to plain `addOrg`: 3 failures

**Limits.** I haven't checked against the native implementation that `Session.installId` mints
persistent keys; that comes from the contract's comment. The regressions prove that no call
happens after invalidation. A sign-out's own unregister still checks the incarnation only, not
the erase epoch, so a sign-out overlapping an erase may unregister alongside the erase, which
unregisters that same org anyway. Headers: I regenerated only the two shell files the tool
flagged. The other remaining stale headers (`Direct.kt`, `DirectAuth.kt`, `NativeHttp.kt`,
`NavigationPolicy.kt`) are native files under active repair and were left alone.

## Sol round 8 shell findings (frozen review of 456 tests, base a3acc113)

| # | Finding | Fix | Regression |
|---|---|---|---|
| 1 (P1) | A host-only `directSignOut({host})` can answer `not_current` when sign-ins kept landing during the removal and native kept the newest (D). Remove machine and Remove route treated that as done, deleting the metadata while D survived. | `removeDirect` returns `{failed, code: "not_current", signedOut: false}` and keeps the machine; the route screen keeps the route. Both say so. DirectCheck's own-id clean-up still treats `not_current` as nothing of its own left. Comment-only corrections in `definitions.ts`, `outcomes.ts` and `mobile-parity-contracts.md` now describe `not_current` for a call without an id. No type, union or native behaviour changed. | `direct.test.tsx`, with a fake native that keeps D: Remove machine and removing a typed route both keep the metadata on disk and in memory, show a toast with `not_current` saying it is still there, and show no success. |
| 2 (P1) | Push work started during an erase took a ticket for the new epoch while the org was still listed, so it reached `Session.installId` while `erasing()` was true. | The ticket's `valid()` also requires that no erase is running, so ordinary push work never runs during one, fresh tickets included. The erase's own unregister stays separate. An ordinary sign-out's unregister also stops while an erase runs. | `pushRaces.test.ts`, with the erase held at its vault wipe and the org still listed: a reconcile, a Turn on, and a resume refresh all reach no `installId`, no `deviceKey` and no `registerDevice`. Control: the same reconcile with no erase asks for the install id. |
| 3 (P2) | A cold notification tap took its ticket after awaiting the machine-list refresh, so a tap held across an erase and re-add muted or opened on the new org's device. | The tap takes its ticket when it arrives, before the refresh, and keeps it through handling. `tapDepsFor(t)` scopes the paired-machine list, the open, the mute and `clearDelivered` to it. A tap for an org that changed meanwhile shows the unpaired toast, goes to Machines and keeps the alert. | `pushRaces.test.ts`: Mute this machine across an erase and re-add sends no PATCH and writes no local mutes; Open opens nothing and clears no alert. Control: an ordinary cold tap loads the list, opens the agent and clears its alert. |
| 4 (P2) | Overlapping mute exchanges of one org: A held, B saved offline meanwhile, then A's late success deleted B's pending patch and replaced B's mirror. | `MuteSync` runs `apply` and `flush` one at a time per org. The local mirror is built from the newest device the Worker returned, then the pending patches, then the new patch, so distinct partial intents survive. `forget` clears the pending patch, the newest device and the turn chain, so a stale exchange never holds up an org added again; its late answer is refused by `live`. | `pushRaces.test.ts`: A held, B offline, A answers ok: B stays pending, the mirror carries both A's `mute_all` and B's machine ids, and the next flush sends exactly B's patch; another org's mute is not held behind this org's exchange. The round 7 late-answer cases still pass. |
| 5 (P2) | When org A went stale mid-way through a registration drain (after its install id), the `StalePushOrg` from a later native call aborted the whole drain, so org B waited for the next trigger. | `drainPending` catches `StalePushOrg` per org and carries on. Any other error still propagates. | `pushRaces.test.ts`: A removed while its device-list request is out; B registers in the same drain, and `registerDevice` is called only for B. |

**Mutation checks for round 8.** Each was restored and compared afterwards, and every one fails
its tests:
- Remove machine ignoring `not_current`: 1 failure
- Remove route ignoring `not_current`: 1 failure
- a ticket valid during an erase: 6 failures
- the tap ticket taken after the refresh: 2 failures
- mute exchanges not serialized: 1 failure
- the mirror built from the passed device only: 1 failure
- the drain without the per-org catch: 1 failure

**Headers.** Checked repo-wide with every untracked file included through a temporary index. I
regenerated the shell files and the "Used by" trees of `cloud/protocol/src/index.ts`,
`mobile/plugins/push/src/index.ts` and `mobile/plugins/secure-store/src/index.ts`, which the
new test file's imports made stale. Each changed by exactly one header tree line. Repo-wide,
`--check` (1116 files) and `--lines --check` now pass. No native header was touched.

**Limits.**
- Native's bound on repeated revocations, and its keeping of D, are as the native contract
  describes; the shell tests use a fake.
- Whether a mint after the vault wipe would persist is not observed. The tests prove only that
  no call is made.
- The machine-view plugin's own test suite was not run, because only comments changed there.

## Sol round 9 shell findings (frozen review of 468 tests, base a3acc113)

The fix is one model rather than five response handlers. `MuteSync` owns each org's mute
intent, and every mute operation runs in that org's one turn: a change, a flush, a reconcile's
publish and a Turn on/off registration. In that turn the mutes in force are the newest device
the Worker returned, with the still-pending patch laid over it. A change is either a fixed
patch or a function of those mutes, decided when its turn comes. The PATCH sent is the pending
patch merged with the new change.

| # | Finding | Fix | Regression |
|---|---|---|---|
| 1 (P2) | A successful partial mute discarded fields still owed from an earlier offline save. | The outgoing PATCH merges the pending patch under the new change: the latest value of a field wins and unrelated owed fields ride along. A success clears what is owed only because the same PATCH carried it. A failed exchange restores the mirror to the mutes in force and keeps what is owed. | `muteIntent.test.ts`: offline `mute_all`, then machine ids answered ok, sends both in one PATCH and leaves nothing owed. `mute_all` true then false keeps the owed `muted_until`. A TLS failure restores the mirror and keeps the pending patch. |
| 2 (P2) | The Settings checkbox and the notification's Mute built a replacement machine list before queueing, from a stale list. | `machineMute(id, muted)` is a change decided in the turn: add or remove one id against the ids in force, "unchanged" when already so, "full" at 100 without sending. Both callers use it. "full" shows its own toast (`push.toast.mute_full`). | `muteIntent.test.ts`: A held, B queued sends `[A]` then `[A,B]`; an unmute and `mute_all` queued behind an add give `{mute_all, [B]}`; 99 muted plus two queued adds sends one PATCH and the second answers "full". `pushRaces.test.ts` covers both real callers: two quick checkbox mutes, and a notification Mute with a checkbox mute queued behind it, each sending `[A]` then `[A,B]`. |
| 3 (P2) | A reconcile whose flush went offline published the Worker's older device to the row and the native mirror. | `reconcileOrg` hands its fetched device to `settle`, which runs in the org's turn. The fetched device becomes the newest only if no answer arrived since the reconcile started. A pending patch is retried, and the row and the mirror get the mutes in force. Registrations also run in the turn (`register`) and are given the mutes in force. | `muteIntent.test.ts`: GET answers unmuted and the owed `mute_all` retry goes offline; the row is muted, the mirror is muted and the patch stays owed. A Worker answer that lands after the reconcile's listing wins over that listing. |
| 4 (P2) | A cold notification Mute with nothing cached and nothing to drain had no device to mute. | `deviceFor(ticket)` uses the cached row, else lists the org's current device through the ticket's scoped deps. It never registers or asks for permission; no row gives the truthful failure toast. | `pushRaces.test.ts`: an empty `pushStore`, an empty drain, and a Mute tap list the device, send `[MACHINE]` and set the local mutes. With no device row there is no PATCH, no `registerDevice` and no `requestPermission`. |
| 5 (P2) | Notification work kept going after the push wiring was torn down. | `installPush(mounted)` takes the caller's lifetime (lifecycle passes its `alive`), and teardown ends it too. Every listener, the tap after its refresh, the open before and after the native call, the mute and the scoped push deps check it alongside the org ticket. If teardown came while the listeners were being added, they are removed at once and nothing drains. | `pushRaces.test.ts`: removed during a cold tap's refresh, nothing opens, no alert clears and the position does not move. Torn down while `MachineView.open` is out, the alert is not cleared afterwards. Torn down before the listeners finished registering, all three are removed and nothing drains. The existing cold Open and cold Mute controls pass. |

**Mutation checks for round 9.** Each was restored and compared afterwards, and every one fails
its tests:
- no pending merge into the PATCH: 7 failures
- a change decided against the caller's device instead of the turn: 5 failures
- `settle` publishing the fetched device: 2 failures
- `deviceFor` cache-only: 2 failures
- no teardown check after the tap's refresh: 1 failure
- no teardown check in `installPush`: 1 failure
- no teardown check after the native open together with unscoped push deps: 1 failure

Each of the last two layers alone survives, because the other still stops the alert clear.
That is defence in depth, not an untested layer. The open-entry check is also a second layer
behind the post-refresh check.

**Headers.** Regenerated `muteIntent.test.ts` (new), and the "Used by" trees of
`pushRegistration.ts` and `pushTestKit.ts`. Its imports also made `cloud/protocol/src/index.ts`
and `mobile/plugins/machine-view/src/index.ts` stale, so each gained exactly one "Used by" line.
Repo-wide `--check` (temporary index) now reports nine files, all native Kotlin and Swift in
progress by the native owner, none touched. `--lines --check` passes.

**Limits.**
- The tests drive fakes of the Worker and the native plugin. No device was run.
- Revocation or a session error that arrives while a merged PATCH is out is covered only by
  existing round 7 and 8 cases. A native mirror write that fails is not modelled.
- Teardown cannot recall a native open already submitted. What is guaranteed is that nothing
  after it runs: no alert clear and no toast.

## Sol round 10 shell findings (frozen review of 483 tests, base a3acc113)

Round 9 queued only the mute and publication steps. Round 10 puts the whole decision in the org's
one turn, together with recording it in `pushStore`:
- A reconcile runs meta, cacheMachineNames, listing, permission, local state, the stale test,
  and the registration or settle in one turn.
- Turn on and Turn off run their registration in a turn.
- Mute changes and flushes run in a turn.

Every turn checks its org context before it touches anything. Every write after an await
checks again. The round 9 `seen`/`settle` bookkeeping is gone: the device a reconcile lists
in its own turn is, by construction, the newest. The registration drain runs each org in its
own turn side by side.

| # | Finding | Fix | Regression |
|---|---|---|---|
| 1 (P1) | A reconcile held at its local state, then Turn off, then the reconcile resumes: the earlier snapshot registered `pushOff:false` after the off, or published Active over it. | `reconcileOrg` runs its whole decision and its publication in `MuteSync.run`. Turn on and Turn off record inside `register`'s turn. A Turn off pressed while a reconcile holds the turn waits for it, then registers off and records off. A reconcile queued behind a Turn off lists the off device. A revocation's clean-up also finishes inside its turn, so a Turn off queued behind it finds the org gone. | `pushTurns.test.ts`:<ul><li>Reconcile held at local state (stale): Turn off waits, `pushOff` order `[false, true]`, the Worker device is off, the row is `turned_off`, and one success toast shows.</li><li>The same with healthy local state: `pushOff` `[true]`, and the published rows are `active` then `turned_off`.</li><li>Turn off held at registration, reconcile queued: local state is not read until off lands, and the end state is off.</li><li>Turn on held, Turn off pressed: `[false, true]`, ending off.</li><li>A revocation whose org removal is held: a queued Turn off registers nothing.</li><li>One org held in its turn, another drained to Active meanwhile.</li></ul> |
| 2 (P2) | An old incarnation's queued reconcile wrote its device into the new org's shared state before it checked liveness. | `run` checks `deps.live` at turn entry. `taken` (the only writer of the newest device) checks it too. `send` and `registered` check after every await before they write. `forget` starts a new chain, and old tails refuse themselves. | `muteIntent.test.ts`: the old exchange is held and the old reconcile queued; the org is forgotten and added again with an offline `[B]`. The old PATCH answers ok, and both old turns reject with `StalePushOrg`. The next mute sends exactly `{muted_machine_ids: [B, C]}`, and the only mirror writes afterwards are the new org's `[B]→[B, C]` pair, with no `mute_all`. |
| 3 (P2) | A mute that found `device_revoked` swallowed it: the cold lookup treated it as "no device", and the cached PATCH treated it as a generic failure. | `deviceFor` keeps `'revoked'` and forgets the native push keys through the ticket's scoped deps. The Settings mute and the notification's Mute both route `'revoked'`, from the lookup or the PATCH, to `record(org, {kind: 'revoked'}, ticket)`. That is the same ticket-fenced clean-up a reconcile uses (`handleDeviceRevoked(id, inc)`). `session_expired` stays a failure. | `pushTurns.test.ts`:<ul><li>Cold GET revoked: the org is removed, `forgetOrg` called, no PATCH, the revoked warning shows and no error toast.</li><li>Cached PATCH revoked: the same, with no generic error toast.</li><li>Notification Mute revoked: the org is removed.</li><li>An old incarnation's PATCH answered revoked after the org was removed and added again: the new org stays, no `forgetOrg`, no warning.</li><li>Cold lookup `session_expired`: the org stays, there is no `forgetOrg`, and an error toast shows.</li></ul> |
| 4 (P2) | A failed Turn off still announced success. | Success is announced only for a recorded `turned_off` row. Any other row shows `push.toast.turn_off_failed` (new). The row keeps its real state and its retry, and a revocation keeps its own warning. | `pushTurns.test.ts`: offline, `session_expired` and `api_error` each give no success toast, one error toast, and a `registration_failed` row. Control: a confirmed off gives one success toast and the `turned_off` row. |

**Mutation checks for round 10.** Each was restored and compared afterwards, and every one fails
its tests:
- the reconcile's decision outside the turn: 4 failures
- the reconcile recorded after its turn instead of in it: 1 failure
- no turn-entry and no `taken` checks: 1 failure
- the cold lookup's revocation read as no device: 1 failure
- the Settings PATCH revocation as a generic failure (the old code): 1 failure
- the notification PATCH revocation as a failure: 1 failure
- Turn off success announced unconditionally: 3 failures
- the drain run org after org: 1 failure

One gap was found and closed: removing only the Settings PATCH routing first survived, because
the reconcile after every mute meets the same revocation and removes the org. The cached-PATCH
test now also asserts there is no generic error toast, which the old code raised.

**Headers.** Wrote the new `pushTurns.test.ts` and the "Used by" trees its imports made stale:
seven shell files, plus one line each in `cloud/protocol/src/index.ts`,
`mobile/plugins/push/src/index.ts` and `mobile/plugins/secure-store/src/index.ts`. The diffs
show only that line. Repo-wide `--check` (1119 files, temporary index) and `--lines --check` now
pass. The native files flagged in round 9 no longer appear; I did not touch them.
`notifyBoundary.test.ts` lists `push/pushTurns.test.ts`, which mocks `sonner`.

**Limits.**
- All four findings are proved against in-memory doubles of the Worker, the native push plugin
  and SecureStore. Nothing ran on a device.
- A turn is held for as long as its native calls take. A native call that never answers holds
  that one org's later push work, but never another org's.
- Whether native Turn off with `offline` leaves keys deleted locally is native's contract and is
  not modelled here. The shell reports only that the off is not confirmed.

## Round 11: `upgrade_required` (shell integration of the native compatibility gate)

The native owner published the additive contract, and the shell did not edit it:
- `DirectFailure` gained `{kind: "upgrade_required"}`, so it reaches `directStatus`,
  `routeStatus` and `directSignIn`.
- `DirectClosedCode` gained `"upgrade_required"`, for direct, routed and org windows.
- Native gives this verdict when a machine's status lacks `native_auth_ui: true`.

It is a compatibility verdict about that machine's yaran build. The shell treats it as "update
yaran there", never as an identity change and never as a reason to remove anything. No
published version number is named.

| Surface | Behaviour | Regression (`upgradeRequired.test.tsx`) |
|---|---|---|
| Window closed with `upgrade_required` (`App.tsx`) | Goes to Machines and shows a warning toast through `upgradeRequiredClosed`: "The yaran on HOST is too old for this app to show it, so its window closed. Update yaran on that machine, then open it again." The host is a chip when native names one; without a host (an org window) the same sentence says "That machine's yaran". The record stays, and there is no instance-changed dialog and no error toast. | With a host: one warning that names it, no "different yaran" wording, no dialog, the route is `machines`, and the record and its instance are unchanged. Without a host: the hostless sentence and no dialog. |
| Status check while adding (`DirectCheck`) | `probeFailureText`: "The yaran on HOST is too old for this app to sign in to it or show it. Update yaran on that machine, then try again." Retry is offered, because checking again helps once the machine is updated; there is no Add or Sign in. | An alert with the update sentence, Try again present, no Add or Sign in button, no `directSignIn`, nothing saved. |
| Sign-in while adding, and Sign in again | `signInFailureText` hands it to the same sentence. Retry is offered, and nothing is saved or removed. | Adding: the update sentence, Try again, nothing saved. Sign in again: an error toast with the update sentence, and the machine stays listed. |
| Keep in the instance-changed dialog (`routeStatus`) | Refused with the update sentence; the old identity stays and nothing opens. | Keep with `routeStatus` → `upgrade_required`: the toast says to update, there is no open, and the instance is still `inst-1`. |
| Adding an org route (`addCheckedOrgRoute`) | Refused with the update sentence; no route is saved. | `told.tone` is error with the update sentence, and the routes are unchanged. |

The new test mocks `sonner`, so `notifyBoundary.test.ts` lists it.

**Mutation checks for round 11.** Each was restored and compared afterwards, and every one fails
its tests:
- the closed code unhandled: 2 failures
- the closed code treated as `instance_changed`: 2 failures
- the closed code treated as a `no_route` error: 2 failures
- `upgrade_required` with no retry: 2 failures
- `upgrade_required` worded as "not like yaran": 5 failures

**Catalog.** 321 messages (318 plus the probe sentence and the two closed-window sentences).

**Headers.** Wrote the new test's block and the trees it and `App.tsx`'s new import made stale:
twelve shell files, plus one "Used by" line in `cloud/protocol/src/index.ts`.
- Repo-wide `--check` still flags `DirectAuth.kt` and `Fakes.kt`. They are native files in
  progress by the native owner, and I didn't touch them.
- `--lines --check mobile/app` passes. Repo-wide, the line gate flags only
  `crates/yaran-web/src/auth/routes.rs` growing past its baseline. That is the owner's Rust
  work in progress, not shell work.

**Limits.**
- Native's actual gate (missing, false or malformed `native_auth_ui` refused before a page is
  admitted or a direct session kept) is native's to prove. The shell tests use answers from the
  mocked plugin.
- Nothing ran on a device.

## Sol round 12 shell findings (frozen review of 506 tests, base a3acc113)

Two rules decide the four fixes:
- **A user's Turn on or Turn off is intent the org's turn owns.** It takes the turn at the
  press, before the permission prompt and every preparation. It stays owed until a device the
  Worker accepts says so: `MuteSync.owe`, confirmed and cleared by `taken`, forgotten with the
  org.
- **A reconcile adopts the device it lists before anything reads its mutes.**

The newly fetched server mutes beat an older cache, and still-owed explicit fields beat both.
Turn on and Turn off are now one `toggle(org, off)` in `pushWiring.ts`.

| # | Finding | Fix | Regression |
|---|---|---|---|
| 1 (P2) | A stale-subscription registration used the older cached mutes rather than the device just listed, so it cleared a mute made elsewhere. | `decide` calls `mutes.taken(listed)` right after listing, in the same turn, before `registered` reads `inForce`. Answers older than this listing cannot exist: every Worker answer for this org is taken inside its turns, and this listing is the newest. | `muteIntent.test.ts`: cache unmuted, the Worker changed to `mute_all` + `[A]`, a `muted_until` owed offline, and the subscription absent. The registration carries `{mute_all: true, muted_machine_ids: [A], muted_until}`, the mirror shows the same, and nothing stays owed. |
| 2 (P2) | Retry after a failed Turn off ran a reconcile, which turned push back on (subscription absent) or showed Active (healthy). | The failed toggle stays owed. The row's Retry repeats the toggle (`pushAction('retry')` → `toggle(org, owed)`, with its toasts), and a reconcile with an owed off registers off rather than on. The intent is forgotten with the org (`forget`), so a replacement org never inherits it, and every retry runs under its own ticket. | `pushToggles.test.ts`, pressing the row's displayed action (`rowView(state).action`): with the subscription absent and with it healthy, the next registration is `pushOff: true`, the row says off and the success toast shows. A resume reconcile after the failure retries off. After a removal and re-add, Retry turns nothing off. |
| 3 (P2) | Toggles took the org's turn only after their metadata or permission awaits, so a held Off A landed after a later On C. | `toggle` runs the prompt, `pushOrgOf`, the metadata, the registration and its publication in one `muteSync.run`, using the unlocked `registered` inside it (no nested turn). The public `register` is gone. | Off A held at metadata, Off B and On C pressed: neither registers while A is held; then `[true, true, false]` and the end state is on. On A held at its permission prompt, Off B pressed: `[false, true]`, ending off. Another org's Turn off completes while the first org's is held. |
| 4 (P2) | A preparation failure (metadata offline, install id refused) was only logged: no row, no toast, and Active stayed. | Inside the turn, a failure that isn't `StalePushOrg` records a `registration_failed` row: "this phone is offline", or "preparing the request failed (code)" with the code checked against `rejectionCode`'s pattern. The toggle stays owed and a failure toast shows. The off toast is `push.toast.turn_off_failed`, and the new `push.toast.turn_on_failed` is for a failed on. `pushDeps.session.meta` now throws with the meta code. A failure for an org gone since is refused at the turn's publication check. | Off with metadata offline: no registration, the row says offline, an error toast and no success; Retry then turns it off. On with `installId` rejected: the row reason is `…(native_error)`, with an error toast. Metadata held, org removed, then offline: no row and no toast. |

Revoked stays its own outcome: a toggle answered `device_revoked` records the revocation and
warns, with no failure toast, and the revocation clears the owed toggle. `upgrade_required` is
unchanged. The pushStrings keys are not Lingui messages, so the catalog stays at 321.

**Mutation checks for round 12.** Each was restored and compared afterwards, and every one fails
its tests:
- the fetched device not adopted before registering: 1 failure
- Retry always reconciling: 2 failures
- Retry reconciling, with the reconcile also ignoring the owed off: 3 failures
- the owed toggle surviving `forget`: 1 failure
- the toggle intent never owed: 12 failures
- the toggle run outside the org's turn: 6 failures
- a preparation failure only logged: 2 failures

**Headers.** Wrote the new `pushToggles.test.ts` and the trees its imports made stale: eight
shell files, plus one "Used by" line each in `cloud/protocol/src/index.ts` and
`mobile/plugins/push/src/index.ts`. Repo-wide `--check` (1124 files) and `--lines --check` both
pass. No native header was touched.

**Limits.**
- In-memory doubles only, and nothing ran on a device.
- An owed toggle lives in memory: a process death drops it, and the next reconcile mirrors the
  Worker again.
- The row title `push.row.registration_failed` used to read "Turning on notifications failed",
  which was untrue for a failed Turn off and for the mute failures that reuse it as a toast. It
  now reads "Updating notifications on this phone failed".

## Sol round 13 shell findings (frozen review of 517 tests, base a3acc113)

| # | Finding | Fix | Regression |
|---|---|---|---|
| 1 (P2) | A cold notification Mute took the org's turn only after its device GET, so a later unmute landed first and the held mute then re-muted. | `MuteSync.applyTo(deps, orgId, lookup, change)` runs the lookup and the PATCH in one turn. The notification's Mute and the Settings mutes (checkbox, hour, forever, unmute) all use it. `deviceFor` runs inside that turn and adopts a device it fetched (`taken`). Unchanged: the cold existing-device fetch only (no registration, no permission), the captured ticket and installation lifetime, and revoked versus no-device. | `pushTurns.test.ts`:<ul><li>Notification Mute with its device GET held; a reconcile and an unmute of the same machine pressed after. No PATCH while held; then `[M]` then `[]`. The Worker and the native mirror end unmuted, with no registration and no permission request.</li><li>Settings mute with its cold GET held, then an unmute: `[M]` then `[]`, ending unmuted.</li></ul> |
| 2 (P2) | The automatic "Reopen last machine", waiting on its machines list, opened after a newer agent link had already opened its machine. | `DeepLinks.arrivals()` counts every link at intake, before any await (file and content URIs excepted; a released held link counts too). The App passes `startUnlocked` a `superseded` check against the count taken before `settled()`. `startUnlocked` also gives way when the screen moved while it waited (a link, a share or the user changed the hash). It checks after every await, and `reopenLastMachine` checks immediately before the native open on both paths. | `reopenPriority.test.tsx`, through the real App with org A's list held:<ul><li>An agent link for B (cached) opens B, and the release opens nothing more.</li><li>A `yaranapp` link keeps its Confirm screen.</li><li>A share shows the share screen.</li><li>The user moving to Settings stays there.</li><li>Control: left alone, it opens the last machine.</li></ul>The existing `launch.test.tsx` ordering (startup twins, locked held links, slow launch URLs) is unchanged and passes. |
| 3 (P2) | A Turn on or Turn off whose native registration rejected (rather than answered) only logged: the old row stayed, there was no toast, and the off stayed owed silently. | The registration is awaited inside the toggle's current-ticket failure handler, together with its preparation. A rejection records `registration_failed` with "the request did not complete (code)", the code checked by `rejectionCode`, and the toggle's failure toast shows. The toggle stays owed for Retry. `StalePushOrg` still says nothing, and revoked, offline and upgrade answers keep their own paths. | `pushToggles.test.ts`: Turn off rejected `unavailable` gives the failure row and toast with no success; the displayed Retry then sends `pushOff: true` again, confirms off and shows success. Turn on rejected gives the failure row and toast. A rejection after the org was removed records nothing and says nothing. |

**Mutation checks for round 13.** Each was restored and compared afterwards, and every one fails
its tests:
- the notification lookup outside the turn: 1 failure
- the Settings lookup outside the turn: 1 failure. It first survived; the Settings deferred test
  was added for it.
- the newer-link check not passed: 1 failure
- links counted only when handled: 1 failure
- screen moves not checked: 2 failures
- the registration returned unawaited from inside the catch: 2 failures

**Headers.** Wrote the new `reopenPriority.test.tsx` and the trees its imports made stale: eight
shell files, plus one "Used by" line each in `cloud/protocol/src/index.ts` and
`mobile/plugins/secure-store/src/index.ts`.
- `--check mobile/app` (120 files) and `--lines --check mobile/app` both pass.
- Repo-wide, the header check flags `MachineWebViewClient.kt` and `RouteDriver.kt`, and the line
  gate flags `crates/yaran-web/build.rs` and `crates/yaran-web/src/web_assets.rs`. All four are
  the native owner's work in progress, and I didn't touch them.

**Limits.**
- In-memory doubles and the real App with mocked plugins. Nothing ran on a device.
- A reconcile's own native rejection is still logged rather than shown as a row. It is not a
  user act, and the next foreground tries again.

## Sol round 14 shell findings (frozen review of 527 tests, base a3acc113)

| # | Finding | Fix | Regression |
|---|---|---|---|
| 1 (P1) | Remove signed out of the hosts it read at the start, then deleted the record as it was by then. A way to reach it approved while the sign-out of A was out (B, with its own session) was forgotten without being signed out. | The final delete runs inside the serialized catalog write and re-checks the record's direct hosts against those just signed out. A host that was not signed out refuses the delete (`routes_changed`). The record and B's metadata stay, and the result is `failed` with `signedOut: false`: not every session was ended, so there is no false "removed". Remove again then ends both. The `signInId` conditional clean-up and host-only `not_current` handling are unchanged. | `directStore.test.ts`: A's sign-out held, B added through `updateDirect`, then released. The result is `{failed, routes_changed, signedOut: false}`, sign-outs `[A]`, and the record has `[A, B]` in memory and in the vault. Remove again signs out `[A, B]` and removes it. |
| 2 (P2) | The automatic reopen could still override two newer choices. A move to Settings while the startup share check was out went unseen, because the screen was captured after that await. An explicit Open of B while A's list loaded went unseen, because opening B does not move the hash. | The App captures the screen (hash) and a machine-choice count when its startup effect begins, before any await. `superseded` is true when a link arrived, the hash moved, or a machine was chosen. `choseMachine()` in `openMachine.ts` is bumped at the tap, before the remember write, in the machine list's Open and in Open for a direct machine. The checks after every await and before the native open are unchanged. | `reopenPriority.test.tsx`, through the real App: Settings chosen while `shareStatus` is held stays on Settings and nothing opens; tapping B while A's list waits opens only B. The round 13 cases (link, share, `yaranapp`, Settings while waiting, the control) and `launch.test.tsx` pass unchanged. |
| 3 (P2) | A mute PATCH that rejected (rather than answered) left the optimistic local mute in force, with no retry and no error. | In `send`, the optimistic mirror and the PATCH share one handler. A throw for the current org puts the mirror back to what is in force, keeps every earlier owed field owed, and returns `failed`, so the caller shows the error toast. A throwing device lookup (`applyTo`) is `failed` too, with nothing sent or mirrored. A throw for an org gone since is `StalePushOrg`: silent, and it touches nothing of a replacement. | `pushRejections.test.ts`, through the real callers:<ul><li>Settings: with an offline `mute_all` owed, a checkbox mute's PATCH throws. The mirror is back to `{mute_all: true, []}`, the patch is still owed with an error toast, and the next change carries `mute_all` again.</li><li>Notification Mute's PATCH throws: the mirror is restored, with an error toast and no success.</li><li>Cold lookup throws: no PATCH, the failed mute is never mirrored, and an error toast shows.</li><li>A throw after a removal and re-add: no mirror write, nothing owed and no toast.</li></ul> |
| 4 (P2) | Turn on's permission step ran before the toggle's failure handling, so a rejected `checkPermission` or `requestPermission` was only logged. | The permission step is inside the toggle's current-ticket failure handling. A throw records the failure row, shows the toggle's failure toast and marks the toggle owed (`owe` in the handler), so the displayed Retry turns it on. A deliberate denial still returns before anything is owed or recorded. | `pushRejections.test.ts`: `checkPermission` and `requestPermission` rejecting each give the failure row with `(unavailable)`, a toast and owed On; the displayed Retry gives `pushOff: false` and Active. A late rejection after removal records and says nothing. Control: a denial records nothing and owes nothing. |

**Split for the line gate.** `pushRegistration.ts` would have passed 500 lines, so `MuteSync`,
`machineMute`, `muteMachine`, `MuteChange`, `MuteOutcome` and `MAX_MUTED_MACHINES` moved
unchanged into `push/muteSync.ts`. `pushRegistration.ts` imports `MuteSync` as a type only, so
there is no runtime cycle. Importers were updated: `pushDeps`, `pushWiring` and two tests.

**Mutation checks for round 14.** Each was restored and compared afterwards, and every one fails
its tests:
- no host-set check at the final delete: 1 failure
- `routes_changed` reported as all signed out: 1 failure
- the screen captured only after the startup awaits: 1 failure
- an explicit open not counted: 1 failure
- a thrown PATCH not handled: 2 failures
- the mirror not restored after a thrown PATCH: 1 failure
- a thrown lookup not handled: 1 failure
- the permission step outside the failure handling: 2 failures
- a failed toggle not owed: 2 failures

**Headers.** Wrote the new `pushRejections.test.ts` and `muteSync.ts` blocks and the trees they
made stale, plus one "Used by" line each in `cloud/protocol/src/index.ts` and
`mobile/plugins/push/src/index.ts`. Repo-wide `--check` (1131 files) and `--lines --check` both
pass. No native header was touched.

**Limits.**
- In-memory doubles and the real App with mocked plugins. Nothing ran on a device.
- A PATCH that threw may still have landed on the Worker. The shell reports a failure, and the
  next reconcile publishes the Worker's truth.
- An automatic reconcile's own native rejection stays log-only, as the review scoped it.

## Sol round 15 shell finding (frozen review of 539 tests, base a3acc113)

| # | Finding | Fix | Regression |
|---|---|---|---|
| 1 (P2) | A notification Open was not a machine choice to the automatic reopen. Opening B leaves the hash as it was and did not touch `machineChoices()`, so releasing A's held list still opened A after B (`[B, A]`). With B's list cold too and A released first, A opened ahead of B (`[A, B]`). | The `notificationTapped` listener calls the existing `choseMachine()` at intake, before the cold-start refresh or any other await. It counts only when the push wiring is installed, the event is well formed, it is an Open (not `mute_machine`), and its ticket is valid (the org exists in this incarnation and no erase started or is running). The tap's handling is unchanged: alerts clear only after a real open, a failed open keeps its alert, unpaired and stale taps keep their refusal, and the installation lifetime checks stay. | `reopenPriority.test.tsx`, through the real App:<ul><li>B's list cached: only B opens, its alert clears, and releasing A opens nothing.</li><li>B's list cold and held, A released first: nothing opens, then only B.</li><li>A failed Open keeps its alert and is still the choice.</li><li>A Mute tap and a malformed tap leave `machineChoices()` unchanged, and A still reopens.</li><li>A tap for an org not on this phone leaves the count unchanged and shows Machines with its explanation.</li><li>The reviewer's 9 probes from round 15 pass.</li></ul> |

**Audit of other explicit opens.**
- Machine-list Open and direct Open already count at the tap (round 14).
- Instance-changed Keep goes through direct Open.
- Agent links count through `arrivals()`.
- The share target's buttons sit on the share screen, so the hash has already moved and the
  reopen has already given way. A count there was tried, and the mutation check showed it adds
  nothing, so it was left out.

**Mutation checks for round 15.** Each was restored and compared afterwards:
- a notification Open not counted: 3 failures
- counted at the open rather than the tap: 1 failure (the cold-list case)
- a Mute counted as a choice: 1 failure
- a stale tap counted as a choice: 1 failure

**Headers.** Wrote `openMachine.ts`, `reopenPriority.test.tsx` and one "Used by" line in
`mobile/plugins/push/src/index.ts`. `--check mobile/app` (122 files) and the line gate pass.
Repo-wide, only native Android files are flagged; those are the native owner's concurrent
repair, and I didn't touch them.

**Limits.** The real App with mocked plugins. Nothing ran on a device.

## Sol round 16 shell finding (frozen review of 545 tests, base a3acc113)

| # | Finding | Fix | Regression |
|---|---|---|---|
| 1 (P2) | A file share arriving while the automatic reopen waited lost to it. The hash moves to `#/share` only after `shareStatus()` answers, so releasing A's list first opened A while the share waited. | `onShareReceived` already marks `shareStore` pending synchronously at a `files` event's intake, before its status pull. The App's startup `superseded` check now also reads `shareStore.get()?.kind === 'pending'`, so a newer file share cancels the reopen from its arrival. `startUnlocked`'s own startup share routing checks only the shell's lifetime, not `superseded`: a waiting share outranks the reopen and must not cancel itself. Unchanged: a refused event (no files, or an unsupported OS) never marks a share, and says why. The lifecycle listener fires only while the shell is alive, and native holds the event until unlock. | `reopenPriority.test.tsx`, through the real App:<ul><li>A's list held, a `files` share arrives with its `shareStatus` held, A released: nothing opens before or after the pull answers, and the share screen shows.</li><li>A `no_files` refusal warns, and the last machine still reopens.</li><li>`launch.test.tsx`: cold-start and later shares still show.</li><li>The round 15 notification cases (cached, cold, failed Open keeping its alert, Mute and malformed controls) and the reviewer's 10 round 16 probes pass.</li></ul> |

**Audit of async navigation intake.** Each one now cancels the reopen synchronously when it
arrives, before any await:
- `appUrlOpen` counts in `arrivals()`.
- `notificationTapped` (Open) counts through `choseMachine()`.
- `shareReceived` (files) sets `shareStore` pending.
- `closed` and user moves change the hash at once.
- The unlock path (`afterUnlock`) runs no reopen.

**Mutation checks for round 16.** Each was restored and compared afterwards:
- a pending share not checked: 1 failure
- any share answer superseding: 6 failures, ordinary reopen broken
- the startup share routing gated by `superseded` again: 3 failures, the waiting-share launch
  tests

The repo test now resets `shareStore` between cases, because the store is module state.

**Headers.** Wrote `App.tsx`, `share.ts` and `reopenPriority.test.tsx`. Repo-wide `--check`
(1132 files) and `--lines --check` pass.

**Limits.** The real App with mocked plugins. Nothing ran on a device.

## Sol round 17 shell findings (frozen review of 547 tests, base a3acc113)

The model this round settles on: both automatic startup steps, the startup share and the
last-machine reopen, give way to anything newer than the launch itself. Each newer intent is
counted when it arrives, before any await:
- a link: `arrivals()`;
- a move: the hash;
- a machine chosen: `machineChoices()`;
- a file share: the new `shareArrivals()`.

The startup pull is not an arrival, so it can never cancel itself. Eligibility no longer reads
the transient pending value, and share-state replies are fenced so an older one never lands.

| # | Finding | Fix | Regression |
|---|---|---|---|
| 1 (P2) | Round 16 let the startup share check only the shell's lifetime, so a held startup `shareStatus` answering `pending` replaced a newer Settings move or add-org link with `#/share`. | `startUnlocked` gates the startup share and the reopen on the same "nothing newer" check again. That check no longer includes the pending value, which is what made the share cancel itself in round 16, so it cannot self-cancel. | `reopenPriority.test.tsx`: startup share held, Settings tapped, then answer `pending`: Settings stays and nothing opens. The same with an add-org link: Confirm stays. Control: with nothing newer, a cold startup share still shows and the last machine does not open. |
| 2 (P2) | An older `shareStatus` reply ("none" from startup) erased a newer files event's pending state, and A opened before the share. | `share.ts` numbers every write: `setShare` (a files event, a send, a discard) and each read's start. A read applies its answer only if nothing was written since it began. A file share also counts in `shareArrivals()`, which the App's eligibility reads instead of the pending value. ShareTarget's send and discard now write through `setShare`. | `share.test.ts`: an older "none" after a newer files event leaves it pending, and the share screen shows. An older "pending" after a discard does not bring the share back. Control: an undisturbed reply is applied. Only `files` counts as an arrival, `refused` does not. `reopenPriority.test.tsx`: startup "none" held, files event with its pull held, old "none" released, then A released: nothing opens before or after the newer pull, and the share screen shows. |
| 3 (P2) | Keep and open counted as a choice only inside `openDirectMachine`, after the route probe and save, so releasing A's list opened A first. | The Keep button calls `choseMachine()` at the press, before any await. `keep()` is unchanged: the pinned identity and host are rechecked across the write, an org remap undoes it, and nothing stale is removed. | `reopenPriority.test.tsx`, through the real App at `#/machines` with A's list held and the dialog up. Keep pressed with its probe held, A released: nothing opens. A successful answer saves the new identity and opens the kept machine only. A failed (offline) answer opens nothing and the identity stays `old`. |

**Audit of intake versus completion on the startup path.** Every explicit route now counts at
intake:
- Settings and other user moves: the hash, at the tap.
- Machine-list Open, direct Open and Keep: `choseMachine()` at the press.
- Links: `arrivals()` at the event.
- A notification Open (validated; not Mute, malformed or a removed org): `choseMachine()` at
  the event.
- A file share: `shareArrivals()` at the event.
- Share-target picks happen on the share screen, after the hash moved.
- A `closed` event navigates synchronously.

Unchanged: ordinary reopen, the launch-link and twin rules, held links after unlock, and the
lifetime gate on every listener. The reviewer's 4 round 17 probes, 10 round 16 probes and 9
round 15 probes pass.

**Mutation checks for round 17.** Each was restored and compared afterwards:
- the startup share ignoring newer intent: 2 failures
- replies not fenced: 2 failures
- a send or discard not outdating reads: 1 failure
- share arrivals not in eligibility: 1 failure
- the startup pull counted as an arrival (self-cancel): 11 failures
- Keep not a choice at the press: 2 failures

**Headers.** Wrote the new `share.test.ts` and the trees it and the tests made stale.
Repo-wide `--check` (1133 files) and `--lines --check` pass.

**Limits.** The real App with mocked plugins. Nothing ran on a device.

## Sol round 18 shell findings (frozen review of 557 tests, base a3acc113)

| # | Finding | Fix | Regression (`continuations.test.tsx`, real App) |
|---|---|---|---|
| 1 (P2) | A warm `files` event's own routing checked only the mount. A Settings move or add-org link made while its status pull was out was replaced by `#/share`. | `installLifecycle` fences each share's routing with `unmoved()`, captured at the share's intake: the shell is alive, the hash is unchanged, `machineChoices()` is unchanged, and the link `arrivals()` count is unchanged. It is used for the `shareReceived` listener and for the share step of `afterUnlock` (taken after that unlock's own held-link release). A refused event never routes. Native still holds the event until unlock. | Settings tapped while the pull is out: a `pending` answer keeps Settings and nothing reopens. An add-org link: Confirm stays. Control: undisturbed, the share screen shows. Torn down mid-pull: nothing navigates. |
| 2 (P2) | Send or Discard of share A whose reply returned after a newer `files` event B cleared B to `none` and left the chooser. | ShareTarget captures `shareArrivals()` at the press, before the native call. If a newer file share arrived by the time the reply lands, the completion neither clears nor navigates; it re-reads what native holds now (`refreshShare`, versioned). An undisturbed Send or Discard clears through `setShare` as before. A rejected Discard still says it failed. | Send and Discard each have their own case: the reply is held, B arrives, the reply completes, and B stays `pending 2` on `#/share`. Controls: an undisturbed Send or Discard gives `none` and Machines. |
| 3 (P2) | An incoming link's `AppLock.status` read was overtaken by a real unlock. The unlock's `release` found nothing held, then the old `locked` answer held the link until another unlock. | `installDeepLinks` counts every `release` (each unlock) in `unlocks`. The lock read (`current`) is re-read whenever an unlock landed while it was out, so a stale `locked` is never trusted, and a re-read still sees a later relock or an unreadable state as locked. The same check is the open-time `mayOpen` for agent links. | The old `locked` answer after Unlock: the link opens once, with no second unlock and no hold toast. Relocked before the re-read: held, then opens once at the next unlock. Torn down mid-read: nothing opens. |

**Native coordination (G5 share identity).** The share contract carries no share identity.
`open({share: true})` hands over "the files held by the last share" and `discardShare()` forgets
"the held share" (`mobile/plugins/machine-view/src/definitions.ts`, `OpenCommon.share` and
`discardShare`). So the shell cannot prove whether a Send or Discard that began for A acted on
A or on a B that native received first. The shell fix keeps B's state and chooser and re-reads
native's truth: if native consumed B, the re-read says `none` and the chooser says the files are
no longer waiting. Native has to make the attribution exact, by ordering share intake against
in-flight commands or by an identity on the held share. That is noted for the native owner, and
no API was invented here.

**Audit of the continuation paths.**
- Share intake: counted (`shareArrivals`) and fenced (`unmoved`) at the event.
- Status: versioned replies.
- Send and Discard: an arrival check at the press.
- Links: a lock read, re-read after any overtaking unlock, then held, released by the next
  unlock, and checked once more by the same read just before the native open.

**Mutation checks for round 18.** Each was restored and compared afterwards:
- the share event fenced only by the mount: 2 failures
- a stale Send clearing: 1 failure
- a stale Discard clearing: 1 failure
- the lock read trusted once: 1 failure
- `release` not counted as an unlock: 1 failure

**Reviewer probes.** Rounds 15, 16 and 17's 23 earlier probes pass. Of the 8 round 18 probes, 7
pass. The eighth fails only at its line 198, which waited for the "Unlock yaran to open that
link" toast. That toast was the stranding itself: with the fix the link is never held, so no
such toast is owed. A scratch copy without that one line passes all 8, including its final
assertion that the link opened after the first unlock.

**Headers.** Wrote the new `continuations.test.tsx` and the trees it made stale, plus one "Used
by" line each in `cloud/protocol/src/index.ts`, `mobile/plugins/push/src/index.ts` and
`mobile/plugins/secure-store/src/index.ts`. Repo-wide `--check` (1134 files) and
`--lines --check` pass.

**Limits.**
- The real App with mocked plugins and faked reply timings. Nothing ran on a device.
- Native share ordering is as described above.

## Round 19: share ownership by batch (shell integration of the frozen contract)

Round 18 found that the share contract carried no share identity, so a Send or Discard pressed
for share A could act on a newer share B that native held first. The parent froze the contract
and the native owner published it (`mobile/plugins/machine-view/src`, contracts §4). The shell
did not edit it:
- `ShareStatus` pending and the `files` event carry `batch`, an opaque random non-secret UUID.
- `OpenCommon.share?: boolean` is replaced by `shareBatch?: string`.
- `discardShare({batch})` takes the batch as a required argument.
- Native compares and acts in one step and rejects a mismatch with `share_changed`, taking
  nothing and opening no window. `no_share` means nothing is held. A discard with nothing held
  resolves.

| Part | Shell change |
|---|---|
| Intake | `onShareReceived` records the event's `batch` in the versioned share state (`setShare`); status replies carry it. |
| Every open path | `OpenTarget.shareBatch` replaces `share`. The one `extras` mapper carries it into the org, direct and routed open options, so every helper passes it through unchanged. |
| Send (ShareTarget) | Each machine button passes the `batch` of the share the screen is rendering, taken at the press, into `openMachine`/`openDirect` as `shareBatch`. It is never re-read later. On `share_changed` nothing was sent: the screen re-reads native, shows the share now held, and says "Newer shared files arrived before these were sent, so nothing was sent". There is no success, no clear and no exit. `no_share` keeps its "no longer waiting" warning, which is silent when a newer share arrived during the press, because that share's state speaks for itself. The round 18 arrival guard on a late `ok` reply stays. |
| Discard (ShareTarget) | `discardShare({batch})` with the batch on screen. On `share_changed` nothing was discarded: the screen re-reads, keeps the chooser and says the newer files are still waiting. Other rejections keep their error. Success and the round 18 arrival guard are unchanged. |
| Erase and clear | The shell calls `discardShare` only from the share screen, with the batch it shows. Erase and the local clears (`setShare({kind: 'none'})` after a confirmed Send or Discard) never discard anything natively, so no shell flow can discard a newer share. |

**Regression (`shareBatch.test.tsx`, real App and share screen).** The native fake compares
the batch atomically: one held share, a newer share replaces it, and `open({shareBatch})` and
`discardShare({batch})` compare and act in one step. A hook runs once, at the first native call
after the press, before a command's compare (a status read included), and has native take in
B first.
- **Send and Discard**, each with B announced to the shell and with B not yet announced: the
  command names A, native answers `share_changed`, and B is still held. The share state is B's
  (`{pending, 2, B}`), the screen shows "Send 2 files to…" on `#/share`, the "nothing was
  sent/discarded" info shows, and there is no success or "Discarded" message.
- **Ordinary Send** hands over exactly `shareBatch: A` and leaves the screen. **Ordinary
  Discard** forgets exactly `{batch: A}` and says so.
- **A gone before Send:** `no_share`, the "no longer waiting" warning and the empty screen.
  **A gone before Discard:** it resolves and leaves.
- **What crosses the bridge:** only the opaque batch id, with no content or file URI or path.
  The share state's keys are exactly `kind`, `count` and `batch`.

The typed fixtures in 7 test files gained deterministic batches (`share-<count>`), and the open
expectations now name `shareBatch`. All earlier share, startup and continuation tests pass
unchanged in substance.

**Mutation checks for round 19.** Each was restored and compared afterwards:
- the batch not carried to native: 8 failures
- the batch re-read from native after the press: 3 failures. The fake's hook first ran only
  inside commands and missed this; it now also runs at a status read, so the test catches it.
- Send's `share_changed` treated as a failure: 2 failures
- Discard's `share_changed` treated as a failure: 2 failures
- the event's batch dropped: 2 failures

**Catalog.** 323 messages: the two `share_changed` sentences were added.

**Headers.** Wrote the new `shareBatch.test.tsx`, the shell trees it made stale, and one "Used
by" line in `mobile/plugins/secure-store/src/index.ts`. The test takes `OpenOptions` through
the shell's own `lib/native/machineView.ts`, so the machine-view plugin index (the native
owner's live file) needed no header change. `--check mobile/app` (125 files) and the line gate
pass. Repo-wide, only the native owner's in-progress Android and iOS share-batch files are
flagged.

**Reviewer probes.** The 23 probes from rounds 15 to 17 pass. Of the 8 round 18 probes, 7 pass,
and the eighth fails only at its toast line 198, as recorded in round 18.

**Limits.**
- The shell drives a fake. Native's own atomic compare-and-act, and that `share_changed`
  consumes nothing and opens no window, are native's to prove, and are under the native owner's
  separate review.
- Nothing ran on a device.

## Sol round 20 shell findings (frozen review of 577 tests, base a3acc113)

The rule: a Send or Discard completion settles the global share state by the identity of the
batch it was pressed for. Only the screen that issued it shows or navigates anything, and only
while that screen is still up. Each command captures its batch and the share-arrival count at
the press. The share screen keeps one lifetime ref (`shown`), set on mount and cleared on
unmount. Leaving by a link, by Settings or by teardown unmounts it.

| # | Finding | Fix | Regression (`shareBatch.test.tsx`, real App, native fake) |
|---|---|---|---|
| 1 (P2) | A late success for A cleared B to `none` and left the chooser when B had been found by a status read (unlock) before its event, because the arrival counter had not moved. | `forget(batch, at)` clears only when no share arrived since the press AND no other batch is the one known now (`shareStore` pending with a different batch). Otherwise it re-reads native through the versioned path. That covers every channel a newer batch can arrive by: an event or any status read. | Send and Discard each: A's reply held, native takes in B with no event, the unlock's read shows B, then A's success arrives. Native still holds B, the store has B, and the screen stays `#/share`. |
| 2 (P2) | A late success navigated to Machines over a newer Settings link, and still acted after the App was torn down. | Navigation, toasts and `setBusy` run only while `shown.current` is true. The global settle (`forget`) still runs, batch-conditional, so a consumed A is not left looking pending because the screen was left, and a newer B is never cleared. The `share_changed` and error toasts are fenced the same way. | Send and Discard each: a Settings link while the reply waits keeps Settings, A is known gone (`none`), and there is no "Discarded" message. Torn down while the reply waits: nothing navigates and nothing is said. `share_changed` after teardown says nothing. |
| 3 (P2) | `no_share` decided its warning before its refresh, so B arriving and showing while the refresh waited still got the obsolete "no longer waiting". | The warning is decided after the last await, through the same `forget`. If a different batch is known now or a share arrived, it stays silent. If the refresh failed or raced and still shows A, A is corrected to gone (native said so) and the warning is said. | B arrives and shows while the refresh waits: no warning, and B stays. The refresh fails: A is gone (`none`) and the warning is said. The normal `no_share` control is the round 19 case. |

Every await ending in Send and Discard was audited: success, `share_changed`, `no_share` and
other failures for both commands. Each now settles the global state by batch, and runs on-screen
effects only while the originating screen is up. The round 18 arrival guard is part of `forget`,
and round 19's batch-conditional native calls are unchanged.

**Mutation checks for round 20.** Each was restored and compared afterwards:
- settled by arrivals only, not identity: 2 failures
- Send navigation not fenced by the screen: 2 failures
- Discard effects not fenced by the screen: 2 failures
- the `share_changed` toast not fenced: 1 failure
- `no_share` decided before its refresh: 2 failures
- `no_share` not correcting a failed read: 1 failure

**Reviewer probes.** All 16 round 20 probes pass. So do the 23 from rounds 15 to 17, and all 8
of round 18's in the scratch copy without its obsolete toast line.

**Headers.** Wrote `shareBatch.test.tsx` and `route.ts`. `--check mobile/app` (125 files) and
the line gate pass. Repo-wide, only the native owner's in-progress files are flagged.

**Limits.**
- The native fake stands in for native. The atomic compare-and-act is native's to prove.
- Nothing ran on a device.

## Sol round 21 shell findings (frozen review of 586 tests, base a3acc113)

| # | Finding | Fix | Regression (`shareBatch.test.tsx`, real App, native fake) |
|---|---|---|---|
| 1 (P2) | `shown.current` is React effect-cleanup liveness, not navigation ownership. A Settings link changes the hash at once, before React unmounts the share screen, so a Send or Discard reply landing in that gap still navigated to Machines over Settings. | Each command pins its originating context at the press with `pressedHere()`: the hash it was pressed on, together with the screen's lifetime. It asks `here()` (mounted AND the hash unchanged) before every screen effect after an await: busy, toasts (`share_changed`, `no_share`, errors, Discarded) and navigation. The global settle (`forget`) runs first and on its own, still batch-conditional, so a consumed A is forgotten even when the screen was left. | Send and Discard each: the link's listener is called outside `act`, the reply completes after the hash is `#/settings` but before React's cleanup, and Settings stays. Nothing is said, and the store is `none` (A forgotten). A failed open landing in the same gap says nothing. Controls: the round 19 and 20 ordinary Send and Discard, and the Settings-link and teardown cases. |
| 2 (P2) | Send on a cold-start chooser (`#/share` at launch, the share found by status only, the launch URL read held) did not cancel the startup reopen. Native consumed A with its reply held, the startup pull then read `none`, and the saved last machine opened as well (`[A, B]`). | Send calls the existing `choseMachine()` at its intake, before the native await. The App's startup `superseded` already counts machine choices, so the reopen gives way. Discard is not a machine choice and is unchanged. | Cold chooser, Send consumed A with the reply held, the launch read released: only `{…, shareBatch: A}` ever opens, before and after the reply. Controls: no press keeps `#/share` and opens nothing; Send answered at once opens only A. |

The round 15 audit treated a choice count at the share screen as redundant, because reaching
the share screen moves the hash. That holds for a warm share, not for this initial-route case:
the app starts on `#/share`, so the hash never moves. The real regression above now pins it.

**Mutation checks for round 21.** Each was restored and compared afterwards:
- screen effects fenced by React lifetime only: 3 failures
- Send not a machine choice at the press: 1 failure
- the global settle gated by the screen: 2 failures, so a consumed A was left pending

**Reviewer probes.** All 67 round 21 probes pass. So do the 16 from round 20, the 23 from rounds
15 to 17, and all 8 of round 18's in the scratch copy.

**Headers.** No module edges changed. Repo-wide `--check` (1137 files) and `--lines --check`
pass.

**Limits.** The native fake stands in for native, and nothing ran on a device.

## Sol round 22 shell findings (frozen review of 592 tests, base a3acc113)

The same two lessons, closed across seven sites:
- React's effect clean-up is not navigation ownership. A link moves the address before it runs,
  so screen effects also check the address pinned at the press.
- An owner captured fresh after an await forgets who started the work. The org incarnation,
  erase epoch or installation lifetime is captured at intake and carried through.

| # | Finding | Fix | Regression |
|---|---|---|---|
| 1 (P2) | `addCheckedOrgRoute` probed, then signed in to and saved for whatever org held that id after a sign-out or erase and re-add. | It captures the org's incarnation and the erase epoch before the probe, and checks them before the probe, before `Session.signIn`, before the second probe, inside the queued `updateDirect` change and as its post-write rollback predicate. A changed org refuses with "…'s org changed on this phone while it was being checked, so it wasn't added." | `intakeBoundaries.test.tsx`: the probe held across a sign-out and re-add, and across an erase and re-add. No sign-in, the route is not saved, and the result is an error. Control: a current org signs in and saves the route. |
| 2 (P2) | Direct approval (`DirectCheck`) saved and navigated when its sign-in reply landed after a Settings link moved the address but before React's clean-up. | `cancelled()` now also checks the address pinned at the press. It is the one predicate used at every await, by the queued `addDirect` write and its rollback, by ConfirmMachine's and MachineRoutes' navigation, and by the clean-up that ends the approval's own sign-in by its `signInId`. | `approvalNavigation.test.tsx`: nothing is saved, Settings stays and there is no success. The own sign-in is ended with `{host, signInId}`. Control: an undisturbed approval saves and goes to Machines. |
| 3 (P2) | ConfirmOrg's sign-in went to Machines over Settings in the same gap. | Its screen effects (`setSignIn` and navigation, including the staging-failure path) check `here()`: mounted and the address unchanged since the press. The org staging, its incarnation-guarded restore and the erase fences are unchanged and independent. | Settings stays after a valid success, and the staged org is still settled (listed). Control: an undisturbed sign-in goes to Machines. |
| 4 (P2) | Held link A (locked), then native unlocked and newer link B opened before the unlock reached the shell; the later release opened A after B. | Any newer link (not a file or content URI) retires the held one synchronously at intake. If B meets the lock itself it becomes the held link, exactly as before. A malformed newer link also retires A: it was the person's newer intent. | `lib/heldLinks.test.ts`: only B opens, once, and a later release opens nothing. Control: with both still locked, only B opens, once, after unlock. |
| 5 (P2) | Turn on's permission step used raw `Push`, so a prompt was requested after an erase had begun. | The toggle passes its ticket-scoped `deps.push` to `turnOnPermission`. An erase, sign-out or re-add makes its next native call throw `StalePushOrg`, which ends silently. The denial, rejection and owed-intent handling are unchanged. | No `requestPermission` after the erase. Earlier tests are the normal prompt and denial controls. |
| 6 (P2) | The registration drain outlived its push installation: torn down while `installId` or `drainPendingRegistrations` was held, it still registered. | `installPush` threads its `installed` lifetime through `drainAll`: the native drain (`scopedPushDeps(alive)`), `pushOrgOf` (checked around `installId`), each org's scoped deps, and so the turn's publication check. Listener- and resume-driven reconciles carry the same lifetime: `reconcilePush(org, alive)`, `reconcileAllPush(alive)` and `refreshAllOrgs(alive)` from the lifecycle. The per-org stale-continue behaviour stays. | Torn down at either held point: no `registerDevice` and nothing published. Control: a live install completes its pending registration. |
| 7 (P2) | A `closed` event reaching the listener while it was still registering, after the App unmounted, navigated and warned. | Early `if (!live) return` at the callback's entry. The late handle removal stays. | No hash change and no warning, and the handle is removed once. Control: a `closed` event after mount still navigates and warns. |

**Connected callers audited.**
- Every DirectCheck consumer (ConfirmMachine, MachineRoutes typed route) uses the same
  `cancelled`.
- Both org sign-in effect paths in ConfirmOrg use `here()`.
- Every push native call outside a toggle is now scoped by a ticket and, where an installation
  started it, by that installation's lifetime.

The round 11 upgrade test now adds its route's org before calling `addCheckedOrgRoute`, since a
route for an org that is not on the phone is refused before any probe.

**Mutation checks for round 22.** Each was restored and compared afterwards:
- F1, the org-route check not fenced: 2 failures
- F2, the address move ignored: 2 failures
- F3, mount-only: 2 failures
- F4, held link not retired: 1 failure
- F5, raw `Push`: 1 failure
- F6, the drain forgetting its installation: 2 failures
- F7, no entry check: 1 failure

**Catalog.** 324 messages (the org-changed sentence was added).

**Reviewer probes.** All 12 round 22 probes pass, as do the 67 + 16 + 23 earlier ones and round
18's 8 in the scratch copy.

**Headers.** Wrote the three new test files and the trees they made stale, plus one "Used by"
line each in `cloud/protocol/src/index.ts`, `mobile/plugins/push/src/index.ts` and
`mobile/plugins/secure-store/src/index.ts`. Repo-wide `--check` (1145 files) and `--lines --check`
pass.

**Limits.** The real App with mocked plugins. Nothing ran on a device.

## Sol round 23 shell findings (frozen review of 609 tests, base a3acc113)

| # | Finding | Fix | Regression |
|---|---|---|---|
| 1 (P2) | Clearing the held slot at a newer link's intake (round 22) was not enough. An older attempt still out could re-hold its link at either await ending: a late `locked` lock reply, or a late native `vault_locked`. The next release then opened A after B, or after a Settings link. | Every link (not a file or content URI) takes an owner number (`newest`) at intake. Its attempt carries that number, and a released link keeps its original owner rather than taking a new one. After any await, only the newest may hold the slot or open: the lock-read hold, the open gate (`mayOpen` = current lock AND newest), the `vault_locked` hold, and the liveness passed to `handleAgentLink`. File and content URIs still retire nothing. The newest link re-holding on the lock is unchanged. | `lib/heldLinks.test.ts`, with the round 23 review probes ported:<ul><li>Late lock reply for A after B: only B opens and the release opens nothing. The same after a Settings link: Settings stays and nothing opens.</li><li>Late `vault_locked` for A after B: A is not held.</li><li>A file or content URI does not retire A; a `yaranapp` link does.</li></ul>Each layer is pinned on its own too: a link that is not the newest raises no "Unlock yaran to open that link" prompt (both hold sites), and A still loading its list when B arrives never opens; only B does. |
| 2 (P2) | The initially locked startup branch called `afterUnlock()`, which captured a fresh context after the unlock. A Settings move made after the unlock and before startup finished was replaced by `#/share`, for both the Unlock button and the native unlock event. | The App's startup computes the launch's own `newer()` once (link arrivals since its release, the hash since the effect began, machine choices, share arrivals). In the started-locked branch it releases the held link and then routes the startup share under `!newer()`. Later unlocks still go through `afterUnlock`, which captures the context current at that unlock, so a pending startup share does not cancel itself. | `approvalNavigation.test.tsx`: locked start with the launch read held. Unlock by button and by native event, follow Settings, finish startup with a pending share: Settings stays. Control: undisturbed, the share screen shows. A link held for the lock at a locked start is released and opens once, even though Settings vetoed the share. |

**Mutation checks for round 23.** Each was restored and compared afterwards:
- the lock-reply hold without the owner check: 1 failure
- the `vault_locked` hold without the owner check, together with the attempt's liveness: 1
  failure. Alone it is backed by that liveness, which ends a superseded attempt before its
  outcome is acted on.
- the open not gated on being newest, together with the attempt's liveness: 1 failure
- the locked branch routing by a fresh capture: 2 failures

**Reviewer probes.** All 21 round 23 probes pass, as do every earlier set (67 + 16 + 23 + 12 +
8).

**Headers.** Wrote the two grown test files, plus one "Used by" line each in
`cloud/protocol/src/index.ts` and `mobile/plugins/secure-store/src/index.ts`. `--check mobile/app`
(128 files) and the line gate pass. Repo-wide, only the native owner's in-progress Android and
iOS files are flagged, and I didn't touch them.

**Limits.** The real App with mocked plugins. Nothing ran on a device.

## Sol round 24 shell findings (frozen review of 622 tests, base a3acc113)

| # | Finding | Fix | Regression (`explicitOpen.test.tsx`, real App) |
|---|---|---|---|
| 1 (P2) | Manual Open (`MachineList`, `openDirectMachine`) awaited the convenience "remember last machine" write before opening. With that write held, a newer agent link opened B and the release then opened the stale A; A also opened after Settings or teardown. | The remember write is queued and not awaited (`void updateSettings(…).catch(log)`), so the native open happens at the tap and nothing newer can slip between them. Unchanged: its failure is still caught and logged, the press-time `choseMachine()`, and the serialized settings queue and erase barrier, so the last tap's write still lands last. No new setting model. | Org and direct each: with the write held, the open has already happened at the tap. Then an agent link (B opens after), Settings, or teardown, and the release brings no further open; the tap is still remembered once the write lands. Controls: a failing write still opens and remembers nothing. |
| 2 (P2) | Keep and open, with its `routeStatus` held, still saved and opened the stale A after Settings, after a newer machine opened (no hash change), or after the App unmounted. | The Keep button captures the press's claim: the dialog's lifetime (the dialog lives as long as the App), the address, and `machineChoices()` taken after Keep's own choice. `keep` checks it after the probe, inside the queued identity write, as part of that write's post-write rollback predicate, and immediately before the native open. A newer agent link now counts as a machine choice at intake (`choseMachine()` in `deepLinks` for `https` links), the same existing signal a list or notification Open raises, because a link opens without moving the hash. The identity and current-route host checks and their rollback are unchanged. | Settings while the check is out: no save, no open. A newer machine from the list: only it opens, and the identity stays `old`. A newer agent link: the kept machine never opens. Torn down: nothing saves or opens. A newer machine opened while the identity write is out: the write is undone and nothing opens. Control: undisturbed, Keep saves `new` and opens. The round 17 failed-probe case still blocks the startup reopen. |

The instance-changed test whose older Keep was superseded by a newer Keep now expects the older
one to end silently, keeping the newer identity. A newer Keep is a newer choice.

**Mutation checks for round 24.** Each was restored and compared afterwards:
- org Open awaiting the write again: 9 failures
- direct Open awaiting the write again: 5 failures
- the Keep claim ignoring newer choices: 3 failures
- ignoring the address: 1 failure
- ignoring the App's lifetime: 1 failure
- an agent link not counting as a choice: 1 failure
- all write and open checks removed: 1 failure

Keeping only the post-write rollback passes, because it already refuses a change made during
the write. The pre-open check covers the single microtask between the write resolving and the
open, which a test cannot reach, so it is defence in depth.

**Reviewer probes.**
- Every earlier set passes (67 + 21 + 16 + 23 + 12 + 8).
- Of the 12 round 24 probes, the 4 Keep cases pass when run on their own.
- The 8 remember-write cases assert that the open has NOT happened while the write is held.
  That is the old awaited ordering this fix removes, as the review itself proposed. They fail at
  that first assertion and leave a held `SecureStore.set` behind, which then stalls the Keep
  control in the same file. The repo test pins the new semantics instead.

**Headers.** Wrote the new `explicitOpen.test.tsx` and the trees it made stale, plus one "Used by"
line each in `cloud/protocol/src/index.ts`, `mobile/plugins/push/src/index.ts` and
`mobile/plugins/secure-store/src/index.ts`. `--check mobile/app` (129 files) and the line gate
pass. Repo-wide, only the native owner's in-progress files are flagged.

**Limits.** The real App with mocked plugins. Nothing ran on a device.

## Sol round 25 shell findings (frozen review of 636 tests, base a3acc113)

The pending agent-link and notification-Open paths now carry the same claim Keep carries
(round 24): the machine-choice count, taken after the opener's own `choseMachine()`, and the
address, both captured at intake. They are checked after every await and immediately before the
native open.

| # | Finding | Fix | Regression (`explicitOpen.test.tsx`, real App) |
|---|---|---|---|
| 1 (P2) | A pending agent link A (its lock read held) still opened after a manual Open of B or a move to Settings: its intake owner tracked only newer links. | `installDeepLinks` captures `claimNow()` (the choice count after the link's own choice, and the address) at intake, and `attempt` requires it as part of `mine()`: at the lock-read hold, the newest gate before the open (`mayOpen`), the liveness passed to `handleAgentLink`, and the `vault_locked` hold. A released held link takes its claim at the release, pinning newer machine choices only. Each unlock path itself routes a waiting share right after the release (the App's started-locked branch, `afterUnlock`), and that automatic move must not cancel the link the person asked for. So the documented exception holds: a valid held link is still released once even when Settings vetoed the startup share. | A's lock read held, then a manual Open: only B opens. Settings: nothing opens and Settings stays. Control: A opens. A link released after an unlock gives way to a manual Open made while its lock read is out. The round 23 locked-start exception and launch tests pass. |
| 2 (P2) | A cold notification Open A (its list refresh held) still opened, and cleared its alert, after a manual direct Open of B or Settings. | The tap captures the Open's claim after its own `choseMachine()`. A Mute or an invalid tap claims nothing of it. The tap checks the claim after the refresh and again inside `openAgent` immediately before the native open. A stale tap ends without a word: no open, no "no longer paired" warning, and the alert kept. The org, erase and installation tickets are unchanged. An open already dispatched keeps the existing post-open installation guard on the alert clear. | A's refresh held, then a manual direct Open: only the direct machine opens, there is no `clearDelivered`, and no info toast. Settings: nothing opens, the alert is kept and Settings stays. Control: undisturbed, A opens and its alert clears once. |

**Mutation checks for round 25.** Each was restored and compared afterwards:
- a link attempt ignoring its claim: 3 failures
- a link's claim ignoring the address: 1 failure
- a released link's claim pinning the address too: 2 failures, breaking the locked-start
  exception
- a released link claiming nothing: 1 failure
- a notification Open unchecked both after its refresh and before the open: 2 failures

The after-refresh check alone is backed by the pre-open check: a stale tap then ends at the
open, still with no open, no toast and the alert kept.

**Reviewer probes.** All 6 round 25 probes pass, as do every earlier set and the round 24 Keep
probes.

**Headers.** Wrote `explicitOpen.test.tsx`. Repo-wide `--check` (1149 files) and `--lines --check`
pass.

**Limits.** The real App with mocked plugins. Nothing ran on a device.

## Checks run (mobile/app)

- `tsc --noEmit`: clean, against the live contract including `ClosedEvent.host` and
  `requestedHost`, `routeStatus`, `RouteStatus`, `secure_storage_failed`,
  `signed_in.signInId` and `directSignOut({host, signInId})` with `not_current`.
- `eslint .`: clean.
- `vitest run`: 49 files, 643 tests passed, three runs in a row (round 25). To stay under the 500-line gate,
  the window-close tests moved to `instanceChanged.test.tsx` and the abandoned-approval tests
  to `approval.test.tsx`.
- `npm run extract` (`lingui extract --clean`): the catalog is current at 324 messages, and the
  i18n freshness test passes.
- `npm run build` (`tsc` plus `vite build`): built. The pre-existing chunk-size warning is
  unchanged. `cap sync` was not run, because the native owner is building.
- Module headers:
  - Scoped to `mobile/app/src` plus the eight shared files below, with the new untracked files
    included through a temporary index (`GIT_INDEX_FILE`; the real index was not touched):
    `--check` OK on 108 files under `mobile/app/src`. `--lines --check mobile/app` OK.
  - Regenerated the stale "Used by" trees in `cloud/protocol/src/index.ts`,
    `mobile/plugins/machine-view/src/index.ts`, `mobile/plugins/secure-store/src/index.ts` and
    `packages/ui-kit/src/{button,dialog,dropdown-menu,inline-code,input}.tsx`. A diff against
    copies taken first shows that only header tree lines changed.
  - The repo-wide `--check` still reports eight stale headers, all in native Kotlin and Swift
    files that are in progress by the native owner.
- The accessibility and dev-build banner tests cover the four new routes.

Not run: any Android, iOS or device check, the cargo gates (no Rust touched), and the
`cloud/protocol` and plugin test suites (not touched).

## Native dependency still owed

1. **The native implementations behind the contract the shell now calls.** On Android and iOS,
   the shell needs:
   - `directStatus`, `directSignIn` and `directSignOut`
   - `routeStatus`, including the org route probe with its own `CF_Authorization` and the
     `sign_in_required` answer
   - the `direct` and `routes` open forms, `share: true` and its `no_share` rejection
   - `shareStatus`, `discardShare` and `shareReceived`, including `retainUntilConsumed` and the
     wait for unlock
   - `Session.signIn` with `target: {machineHost}` for an org machine that has no session

   The shell is typed against all of them and does not assume any is live.
2. **Conditional sign-out is integrated; its native side is only faked here.** The shell's
   abandoned-approval clean-up passes the `signInId` from its own `signed_in`, and treats
   `not_current` as no session of its own left. Remove still sends plain `{host}`, as the
   contract says. The A-shell/B-window regression runs against a fake that follows the
   contract. Two things are native facts the shell cannot prove: the id comparison repeated
   across iOS network awaits, and a new sign-in revoking the session it overwrites (which keeps
   a superseded shell sign-in from being stranded). Both are in the parent's native review.
3. **What an erase leaves on a server.** A clean-up that fails during an erase lists nothing,
   because the erase's vault wipe removes the session from this phone. The machine's
   server-side token is then ended only by its own idle limit, or by Sign out on the machine.
   Settings writes are now inside the erase barrier (round 6, finding 3).
4. **Runtime facts not proven on a device:**
   - native acceptance of the open forms, and the password sheet
   - the `cli-login` cookie (track A's `cookie_name`)
   - the share event's wait for unlock. The parent saw share intake and discard work on a
     device, apart from the false link warning fixed in round 2 finding 4.
   - the `/open` App Link and the publisher domain in a release build
   - the `instance_changed` (with `host` and `requestedHost`) and `no_route` closes, and the
     signed-in agent experience in the machine window
   - the 3 s startup-twin window, which is a guess about Capacitor's delivery timing on a cold
     start

   - Erase everything waits for any open direct password sheet to finish, because a native
     sheet cannot be cancelled from JavaScript. On a phone that sheet is modal, so the wait
     should be what the user is already doing, but this is unproven.

   These belong to the parent's device run once tracks A, B, D and E land.


## Round 26: queued app links and notification preferences

The parent applied the three small findings from the complete frozen review of round 25.

- Non-HTTPS link jobs now check their existing intake owner and navigation claim at their queue turn before routing. An older queued Settings or add-org link cannot change the destination after a newer link or manual move. HTTPS attempts and the held-link release exemption keep their existing checks.
- An hour mute explicitly sends `mute_all: false` with its deadline. This replaces an earlier Forever choice inside the existing per-org queue without dropping machine-specific mutes.
- Notification Settings re-reads the native distributor list after selection settles. An effect lifetime discards late list replies after replacement or teardown. The picker renders only the confirmed native value, including when selection failed.

`heldLinks.test.ts` retains the delayed-front-link/newer-agent and delayed-add-org/manual-navigation regressions. `notificationPreferences.test.tsx` retains the real Settings interaction with Forever held before Hour, assertions on the Worker double/native mirror/published row, the confirmed picker change, and ordinary duration/mount controls. Before the repair, four tests failed across the three findings. Afterward, all 650 tests across 50 files pass. Typecheck, lint, production build, the full temporary-index module headers check and the line gate pass. All ten original independent review probes pass unchanged.

Only small parent repairs and their checks were added; the earlier Opus implementation stays in place. No native behavior, contract, Rust, Worker, private configuration, real index or worktree changed. The new test's imports required eight derived header updates, each verified to leave the rest of its file unchanged.

Limits: native and Worker outcomes are doubles. Distributor installation, real notification delivery, phone sign-in/streaming and the final APK were not tested here. Full shell approval is still pending a new independent frozen review.


## Round 27: delayed launch URLs and QR completion

The parent repaired both P2 findings from the complete frozen round 26 review.

The cold launch captures its existing link owner and navigation/choice claim before listener registration and the `getLaunchUrl` wait. A newer warm link, machine choice or screen move retires that old result before it receives a new intake. The existing cross-delivery twin suppression, file/content exemption and held-link release policy remain in place.

Each QR scan captures its mounted lifetime, originating hash and machine-choice count. Both its success and failure continuations check that context before changing state or navigating. Cleanup ends its lifetime before stopping the camera. The choice count also covers a newer agent or manual machine open which leaves the hash unchanged.

Retained regressions use the real App for the late launch link versus a newer link or Settings. The onboarding tests cover both decoded add-org/add-machine branches after a newer Settings move, completion after teardown, and a newer machine choice without a hash change. Five tests failed before the original repairs; the additional same-hash choice test failed before that guard was added. All six now pass, together with all 656 tests across 50 files. Ordinary launch, scanning, twin-delivery and locked-start controls remain green.

Typecheck, lint, production build, full temporary-index headers and the line gate pass. The three updated module headers were checked to leave file contents outside their generated blocks unchanged. The original review probes pass: late launch 3, real App intake 4, real scanner 3, with its unrelated launch case filtered by the supplied command.

No native, Rust, contract, Worker, private configuration, real-index or worktree changes. Native review 15 approval stays in force. The unsigned round 9 APK is stale for these shell changes and remains held until its sources are refreshed and the full shell review is clean. All checks here use native doubles; no physical sign-in, camera, authenticated stream or final APK installation is claimed.


## Round 28: abandoned staging and security failures

The parent repaired both P2 findings from the complete frozen round 27 review.

Confirm org checks its existing `here()` after the staging write and immediately before native sign-in. If the screen is gone, a synthetic cancelled outcome follows the existing epoch/incarnation guarded restore/remove path. It dispatches no browser flow. A sign-in already dispatched still settles its staging independently of screen navigation, as before.

Security Settings catches enable, disable, options, privacy and initial/follow-up read rejections. A rejected operation preserves the last confirmed state; an unread initial state leaves its control disabled. Success messages follow the confirmation read, so a rejected read cannot accompany a success toast. The obsolete assertion that every option failure means passcode fallback cannot change while locked was replaced with a truthful failure carrying the existing sanitized `rejectionCode`, rendered as an `InlineCode` chip. Lock Screen catches rejected unlocks in an inline alert and invokes no unlocked callback. Its mounted lifetime also stops late unlock completion after teardown. Error messages and unsafe code strings are never rendered.

Retained regressions:
- Real App: held org staging, then Settings or teardown, then release: no sign-in, no saved org. With a previous org, its metadata is restored on disk and in memory. Existing already-dispatched success settlement controls still pass.
- Enable/disable/privacy rejections and status-read failures after enable/options: feedback, confirmed control unchanged, no success.
- Initial lock/privacy read rejection: feedback and disabled unknown control.
- Unlock rejection: inline sanitized failure, locked screen retained, no callback; completion after teardown: no callback.

Nine new cases failed against the old handlers before the repairs, with six unhandled rejections reported. All 668 tests across 50 files now pass with no unhandled rejections. Typecheck, lint, production build, complete temporary-index headers1150 and line2689 gates pass. Original independent probes pass unchanged: approval preparation3 and security feedback/controls6. The catalog has325 messages after adding two failure sentences and removing the obsolete option-change sentence.

Four derived header blocks were regenerated and checked to leave the rest of their files unchanged, including the shared InlineCode component's Used by entries. No native, Rust, cloud, contracts, private configuration, real-index or worktree changes; native15 and server approvals remain closed. The round9 unsigned APK stays held/stale until a clean full shell review, then final source refresh and rebuild. These are native doubles, not physical biometric, privacy, browser or authenticated stream proof.


## Round 29: route and approval ownership

The parent repaired both P2 findings from the complete frozen round28 review and checked the adjacent direct approval against the same newer-choice sequence.

Machine Routes captures its mounted lifetime, initiating hash and machine-choice count at the Add press. The existing org incarnation/erase predicate also checks that ownership before and after preparation and sign-in, inside the queued catalog write, and in its post-write cancellation/undo. A retired Add starts no sign-in, saves no route, and raises no success or stale-org warning. Its busy state settles only while the component remains mounted. Explicit Remove and reorder commits keep their existing semantics. A failed undo leaves the matching saved route in memory/storage and raises a truthful global error even after the screen was left; it no longer claims nothing changed.

Confirm Org pins `machineChoices()` in its existing `here()` predicate. A newer agent or manual machine open can retire staging even when it leaves the hash unchanged; abandoned staging uses the existing guarded restore/remove path. Sign-ins already dispatched still settle globally. DirectCheck had the same gap, reproduced through the real App, and now includes the choice count in its existing cancellation predicate. That predicate already reaches preparation, save, undo, and conditional cleanup by the approval's own signInId.

Eleven retained regressions in approvalNavigation.test.tsx cover:
- Org-route probes before sign-in and before save, each across Settings, teardown, or a newer machine choice.
- A route write across Settings or teardown, which is undone on disk and in memory.
- A failed undo after Settings, which retains the written route and shows its global failure instead of success.
- Org staging and direct approval across a newer machine choice without a hash move. The direct case ends only its own sign-in and keeps the already-listed machine.

The before-repair run reported11 new failing cases; the independent review probes separately reproduce both original findings. All26 approval-navigation cases now pass. The native write fake is reset per case so a failed rollback scenario cannot leave a queued rejection for the next case. All679 tests across50 files pass; typecheck, lint, production build, full temporary-index headers1150 and line2689 pass. Original independent review28 probes pass unchanged, eight cases including their three undisturbed controls. The catalog has326 messages after adding the truthful failed-undo sentence. No module import graph changed, so no header rewrite was needed this round.

Native/platform/contract/Rust/cloud sources are unchanged and native15/server approvals remain closed. Private configs, the empty real index and24 worktrees are preserved. The APK remains held/stale, with final refresh/build deferred until the full shell review is clean. Tests use native/API doubles; no physical authentication, browser, streaming or final signing is claimed.


## Round 30: global rollback failure feedback

The parent repaired both P2 findings from the complete frozen round29 review.

Keep handles `rollback_failed` before the retired-screen return and globally explains that the new identity remains saved, with its checked code and machine label. It opens nothing and changes no destination. Other obsolete Keep results remain quiet.

Confirm Org no longer discards cleanup rejections. A failure to remove or restore its still-current staging raises a global error with the checked native code and guidance to review or sign out of the retained org. The error handler rechecks the erase epoch, active erase and org incarnation after the failure; an erase or replacement that overtook cleanup stays quiet. A false result from the existing guarded cleanup remains a normal superseded outcome.

Seven retained cases cover Keep failed undo after Settings and teardown, a quiet successful undo, failed org cleanup after Settings/teardown/previous-org restoration, and an erase overtaking held cleanup failure. Before repair five cases failed and both quiet controls passed. All54 tests in the two touched test files, and all686 tests across50 files pass. Typecheck, lint, production build, complete temporary-index headers1150 and line2689 pass. All seven original independent review29 probes pass unchanged. Catalog328 adds two truthful failure sentences. Only the two affected generated header blocks were rewritten, checked to leave the rest unchanged.

### Additional overlap found during parent verification

The parent then tested two dispatched sign-ins to the same org across navigation. A begins, the user returns through Settings and starts B, then A's cancellation arrives while B waits. The real App with native doubles removes the org used by B; even after B answers signed_in it remains missing. The org appearance incarnation is unchanged by each refresh, so it does not distinguish those staging attempts. This is a separate observed shell issue, not a claim about physical native credentials.

The private failing check and configuration are `/private/tmp/yaran-main-integration.UcYcSM/concurrent-org-staging-probe.test.tsx` and its .config.mts; the log records both the pending-B and completed-B empty-org assertions. The original shell implementation owner is to repair staging ownership before the next fresh full review. The 686-test state is therefore not approved despite its passing repository suite. Native15/server scopes stay closed. No final APK rebuild/signing/install or authenticated physical streaming is claimed.

## Round 31: org staging owned by the sign-in that staged it

This repairs the overlap recorded at the end of round 30. Two dispatched Confirm org sign-ins
to the same org (A, then B after a trip through Settings): A's cancellation removed the org B had
staged, because a refresh of the same org keeps its appearance incarnation, so the incarnation
cannot tell the two stagings apart.

**Fix (`orgStore.ts`, `ConfirmOrg.tsx`).** Each staging is bound to the org-list write that
produced it, inside the existing write queue (no new queue, nothing waits on an abandoned browser
flow):
- `stageOrg` writes the record and, in that write's commit, makes the staging the entry's owner
  with a token. Its `previous` is the durable record from before every unsettled staging: a
  staging over one still unsettled inherits that one's `previous` rather than taking the
  unsettled record as its baseline.
- `unstageOrg` (a failure or cancellation) acts only while its staging still owns the entry. It
  puts `previous` back, decided inside the write, or forgets the org through `removeOrgLocal`
  when nothing was durable before. That removal re-checks ownership, and that no durable fallback
  was handed over, at every step.
- `settleStaging` on `signed_in`: as the owner it settles the entry. Under a newer staging still
  out, its record becomes that staging's `previous`, because it is durable now (the sign-in
  already happened). The global settlement of an already-dispatched sign-in is kept.
- An older success no longer refreshes or navigates when a newer staging owns the entry.
- An org removed by anything (sign-out, revocation, cascade) drops its staging inside the same
  write, and an erase clears all stagings. The erase-epoch and incarnation fences are unchanged.
- `removeOrgLocal` gains an optional extra claim, defaulting to true, so every other caller (sign
  out, device revoked, push) keeps its incarnation semantics. `addOrg` and `restoreOrg` are
  unchanged for their callers.
- The round 30 clean-up failure toast additionally requires that the staging still owns the
  entry, so a superseded clean-up stays quiet.

**Regressions (`orgStaging.test.tsx`, real App, store and native doubles).**
- A cancelled while B is out: the org stays, and B's `signed_in` keeps it and goes to Machines.
  This is the parent's exact probe, which also passes unchanged.
- A new org with A and then B cancelled: B, the owner, forgets it.
- An org already on the phone, A cancelled then B declined: the original record is put back,
  not either staging.
- A signs in while B is out, then B is cancelled: A's durable record stays, and A's late success
  does not navigate over B's Confirm screen.
- B signs in first, then A's late cancellation changes nothing.
- An erase while both are out: neither late answer brings the org back.
- Controls: one cancelled sign-in forgets the new org it staged; one signed-in sign-in keeps it
  and goes to Machines.
- Helpers: a staging removed by a sign-out and re-staged leaves the old token owning nothing and
  changing nothing, and `removeOrgLocal` without a claim keeps its incarnation semantics.

**Mutation checks.** Each was restored and compared afterwards:
- `unstageOrg` back to incarnation-only clean-up: 3 failures
- a newer staging taking the unsettled record as its baseline: 2 failures
- an older success handing nothing over: 1 failure
- an older success navigating over the newer: survives. That screen instance has already
  unmounted, so its `here()` is false, and one mounted screen cannot start a second sign-in
  (the button is disabled while one runs). The owner gate is defence in depth.

**Checks.**
- Typecheck, lint and the production build pass.
- `vitest run`: 51 files, 696 tests, three runs in a row, preserving all 686 earlier cases and the
  round 26 to 30 repairs.
- The catalog is current at 328 messages.
- Complete temporary-index headers (1151 files) and the line gate (2690 files) pass. Only header
  trees changed: the new test's, and one "Used by" line in `mobile/plugins/secure-store/src/index.ts`.
- The parent's probe passes.

**Limits.**
- No device, browser or native run, and no claim about physical tokens. The native double stands
  in for `Session.signIn`.
- Native, server and contract scopes are untouched.
- The held round 9 APK is stale until the parent rebuilds it. Shell sources to recopy:
  `lib/orgStore.ts` and `screens/onboarding/ConfirmOrg.tsx`.



## Round 32: incarnation check before successful settlement

The complete frozen Sol review30 found two more staging cases. The parent applied the small first fix: Confirm Org checks its captured org incarnation and erase state before calling settleStaging. A success from an org that was signed out or removed cannot become the fallback of a replacement at the same URL. Successful dispatched sign-ins within the same incarnation still settle globally.

Two retained real-App/store regressions in orgStaging.test.tsx cover ordinary sign-out then a new staging, and a durable replacement with a different name/team. Both failed before the check moved; with the fix they preserve an empty new-org baseline or the replacement's metadata in memory and storage. All698 tests across51 files pass; typecheck, lint, production build and complete temporary-index headers1151/line2690 pass. Catalog328 unchanged. No import graph or header rewrite was needed.

The original eight independent probes now have six passing cases and two failures. The remaining failures are the second review finding: B's cleanup writes a deletion/restoration snapshot while A succeeds and changes its fallback, then the old snapshot is published after the storage await. The successful handover is lost. The original org-store owner is to repair this broader write/settlement consistency issue before the next full review. Native15/server scopes remain closed, private configs/index/worktrees are unchanged and the APK stays held/stale. No physical runtime or signing proof is claimed.

Evidence: /private/tmp/yaran-main-integration.UcYcSM/incarnation-guard-before-fix.log, round32-incarnation-*.log and staging-probe-after-incarnation-fix.log. Independent originals are /private/tmp/yaran-shell-review32-pb4zv_yp/staging-probe.test.tsx and .config.mts; do not edit them.

## Round 33: clean-up stores what is true before it publishes

This repairs the remaining review30 finding, recorded in round 32. B's clean-up computed its
deletion or restoration from the fallback at the time, then awaited the vault store. A's
successful sign-in moved that fallback during the await (`settleStaging` hands A's durable record
to the owner), and the stale list was published afterwards. The org disappeared, or the old
name and team overwrote A's.

**Fix (`orgStore.ts`), inside the existing org queue turn.** No new queue, no waiting on a browser
flow, and no native API.
- `write` takes an optional `read`: what the change decided from outside the list (here, the
  staging's fallback). After the vault store, and before anything is published, it compares
  `read()` with what the change saw. If it moved, the list is decided again from the same base
  and stored again in the same turn, so nothing can interleave: every other org write is queued
  behind it.
- A failed second store publishes exactly what the vault holds, the first list, so memory never
  differs from disk, and throws `CatalogRefusal('fallback_unsaved')`. An erase in between still
  throws `erased` and publishes nothing.
- `unstageOrg` is one write for both outcomes: it puts the fallback back, or removes the org when
  there is none. That write passes the fallback as `read`.
  - The removal's preparation keeps `removeOrgLocal`'s order and checks: forget the machine cache,
    last machine and routes first, rechecking ownership and incarnation, so a newer staging
    committing meanwhile wins and the list is untouched. The original probe for this passes.
  - `muteSync.forget` runs only when the org is really gone afterwards.
  - `removeOrgLocal` is back to its original signature and semantics for sign-out, revocation
    and push.
- Staging ownership and the durable baseline, appearance incarnation and its round 32 check
  before settlement, erase fences, same-incarnation settlement of dispatched sign-ins, quiet
  superseded outcomes, and the round 30 global failed-undo feedback are all unchanged.
- `ConfirmOrg`: a `fallback_unsaved` clean-up says, while not erased or erasing, "A sign-in to
  {name} succeeded, but the app couldn't save its details. Check Orgs, and add the org again if it
  is missing or out of date." It never says the entry is "still saved". Catalog: 329.

**Regressions (`orgStagingSettle.test.tsx`, real store, vault double and the real App).**
- Deletion timing: B removes a new org with its store held, A settles, then the release. The org
  stays with A's record in memory and in the vault, and no staging is left.
- Restoration timing: the original "Old name", B putting it back with its store held, A settles.
  A's name and team win in memory and in the vault.
- Control: with nothing settling, the removal takes exactly one store.
- The corrected store fails: the clean-up rejects with `fallback_unsaved`, and memory equals the
  vault (the deletion).
- Through the real App, two dispatched sign-ins: B cancelled with its store held, A signs in, the
  corrected store fails. One error toast with the truthful sentence, no "still saved", and memory
  equals the vault.
- The reviewer's original 8 probes all pass, including the two this round targeted, as does the
  round 31 parent probe. All 698 earlier tests pass.

**Mutation checks.** Each was restored and compared afterwards:
- no re-decision across the store: 4 failures, and the 2 original probes fail
- the clean-up naming no fallback to watch: the same 4, plus the 2 probes
- a failed corrected store publishing the unsaved list: 2 failures
- a failed corrected store being swallowed: 2 failures
- no truthful `fallback_unsaved` message: 1 failure

**Checks.**
- Typecheck, lint and the production build pass.
- `vitest run`: 52 files, 703 tests, three runs in a row.
- The catalog is current at 329 messages.
- Complete temporary-index headers (1152 files) and the line gate (2691 files) pass. The written
  header trees were verified to change header lines only; the shared
  `mobile/plugins/secure-store/src/index.ts` gained exactly one "Used by" line.

**Limits.**
- Doubles for the vault and native sign-in. No device, browser or native run, and no physical
  credential claim.
- The second store is attempted once per change of the fallback. A vault that fails it leaves the
  older durable state, said truthfully, not a retry loop.
- Native, server and contract scopes are untouched. The held APK is stale until the parent
  rebuilds it. Shell sources to recopy: `lib/orgStore.ts` and `screens/onboarding/ConfirmOrg.tsx`
  (and the catalog).



## Round 34: shell Back entries and explicit preference failures

Complete frozen-shell Sol review31 approved the staging repairs and requested two P2 fixes.
The parent applied these bounded caller/router changes directly. Native15 and SERVER scopes
remain closed; no native, contract, served-machine or Worker implementation changed.

- `lib/route.ts` now installs a consumer of the existing shared modal registry for the shell's
  lifetime. `lib/modalNavigation.ts` gives a user-opened dialog or menu a same-screen history
  entry. Back closes the modal through its own cancellation, then the next Back traverses the
  page. Cancel retires the entry; a menu opening a dialog can hand over its entry. A route
  selection reuses the entry for the destination, and a same-screen move removes it instead
  of duplicating the page. Automatically raised dialogs without user activation get no entry.
  Retired modal entries encountered with Back/Forward are skipped. Navigation API indices
  select the traversal direction when available; the basic-history fallback returns behind
  a retired entry. No physical Back gesture was exercised.
- `Settings.tsx` catches failure of the explicit reopen switch write and reports a sanitized
  code with a retry instruction. The controlled value still comes only from confirmed saved
  settings. Manual Open's caught, nonblocking remember write is unchanged.

Checks:

- `modalNavigation.test.tsx`: seven real-App cases for dialog/menu Back, subsequent page Back,
  Cancel, menu route selection, same-screen navigation, and both shared primitives with a
  Navigation API/history model and active user gesture. The basic cases also use jsdom's real
  asynchronous hash history. Forward onto the just-dismissed final entry returns to its page.
- The existing settings test file gained two real-App cases, one per starting switch value:
  an unavailable write preserves disk/memory/control, gives one sanitized error without raw
  diagnostics, and retry persists the requested value.
- Original reviewer probes pass: two basic-history modal cases, two supported Navigation API
  modal cases, and three preference cases. Deliberately removing the adapter, Cancel retirement,
  or the explicit preference catch makes its targeted test fail; each mutation was restored.
- Full suite: 53 files, 712 tests. TypeScript, ESLint and production build pass. The catalog is
  current at 330 messages. Complete temporary-index header check passes for 1,154 files; line
  gate passes for 2,693 files with no accepted growth. Existing generated header updates only
  describe the new imports/callers. New module and test files are below the 500-line cap.

The native plugins and storage are doubles in these tests. Browser history and user activation
are modeled for the supported-API cases; physical Android/iOS gesture timing is not proven.
No device, browser, account, live service, installation, signing or deployment operation ran.
The combined unsigned round9 APK is still held and stale until source recopy and rebuild.


## Round 35: retired modal markers and QR frame failures

Complete frozen-shell Sol review32 found two P2 defects. The parent applied both small fixes;
no native Android/iOS, authentication/capability, storage or SERVER implementation changed.
The shared QR package's browser scanner is a connected shell caller and is included in the
next complete shell review; native15 and SERVER approvals otherwise stay closed.

- `modalNavigation.move` preserves the outgoing modal marker when returning to its base page,
  including a newer navigation queued during cleanup. The requested hash still changes at
  once, so other ownership guards keep their existing timing. A slot reused as a lasting
  route still loses its modal marker. Forward can now identify and skip the retired slot after
  a same-screen Settings link or replacement, instead of stopping on a duplicate page.
- `@yaran/qr`'s `scanner.tick` catches frame drawing, pixel reading and decoder failures,
  tears down the camera, and rejects the scan result through the existing typed error path.
  An unavailable canvas context also ends with camera_failed. A failure after stop is handled
  quietly, and no new frame is scheduled after stop. The existing ScanQr screen supplies
  recovery feedback and Scan again without a new message or dependency.

Regression evidence:

- Three new real-App asynchronous-history cases preserve Forward and subsequent meaningful
  Back after the actual Settings app link, replacement navigation, and a newer navigation
  queued while cleanup is pending.
- Six new ScanQr cases use the real scanner with camera/decoder doubles. Decoder rejection,
  draw failure, pixel-read failure and missing canvas each stop the camera and permit retry.
  A delayed decoder rejection after teardown stops nothing twice and raises no unhandled
  rejection; the existing camera-play failure path remains a passing control.
- Before the repair, the targeted cases produced six assertion failures and four unhandled
  rejections. Afterward all 16 targeted cases pass. The original reviewer probes also pass:
  two modeled-history cases, four asynchronous-history cases and two QR cases.
- Deliberately removing each marker preservation or the decoder catch fails its targeted
  regressions. All three mutations were restored byte for byte.
- Full shell suite: 54 files, 721 tests. Shell TypeScript, ESLint and production build pass;
  the catalog stays at 330. QR package TypeScript and all 20 package tests pass. Complete
  temporary-index headers pass for 1,155 files and the line gate for 2,694, with no growth
  accepted. Four generated header updates changed no implementation.

This evidence uses jsdom histories and camera/decoder doubles, not physical camera or gesture
execution. No account, device, rendered browser, service, signing, installation or deployment
operation ran. The round9 unsigned combined APK remains held and stale for these changes.
