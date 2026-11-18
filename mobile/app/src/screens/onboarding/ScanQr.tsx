/**
 * Scan QR: the camera preview that reads an add-org or add-machine QR code.
 *
 * The camera permission is requested by `getUserMedia` (the WebView maps it to the native
 * prompt). A decoded add-org link goes to Confirm org and an add-machine link to Confirm
 * machine, each with the address shown as a chip; any other code says what it was and keeps
 * scanning possible. The typed path is always one tap away.
 *
 * - Stops every camera track when the screen unmounts.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/onboarding/ScanQr.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/qr:src/index.ts
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgUrl.ts
 * ├── src/lib/route.ts
 * └── src/screens/Page.tsx
 * External: @lingui/core, @lingui/react, lucide-react, react
 *
 * Used by:
 * src/screens/onboarding/ScanQr.tsx
 * ├── src/App.tsx
 * ├── src/screens/onboarding/onboarding.test.tsx
 * └── src/screens/onboarding/scannerFailures.test.tsx
 * <module-headers:end>
 */
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { CameraOffIcon } from 'lucide-react';
import { parseAddMachineUri } from '@yaran/protocol';
import { ScanError, parseAddOrgPayload, startScan, type ScanFailure } from '@yaran/qr';
import { Button } from '@yaran/ui-kit/button';
import { useEffect, useRef, useState } from 'react';

import { normalizeTypedOrgUrl } from '../../lib/orgUrl.ts';
import { machineChoices } from '../../lib/openMachine.ts';
import { navigate } from '../../lib/route.ts';
import { Page } from '../Page.tsx';

type Problem = ScanFailure | 'not_yaran' | 'not_add_org' | 'invalid';

function problemMessage(p: Problem): MessageDescriptor | null {
  switch (p) {
    case 'cancelled':
      return null;
    case 'permission_denied':
      return msg`The camera permission is off. Turn it on for yaran in the phone's settings, or type the org address instead.`;
    case 'no_camera':
      return msg`No camera was found. Type the org address instead.`;
    case 'camera_failed':
      return msg`The camera couldn't start. Type the org address instead.`;
    case 'not_yaran':
      return msg`That QR code isn't a yaran org or machine code. Scan the code your admin or yaran cloud pair-phone shows.`;
    case 'not_add_org':
    case 'invalid':
      return msg`That yaran code doesn't contain a valid org or machine address.`;
  }
}

export function ScanQr() {
  const { i18n } = useLingui();
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!video.current) return;
    let live = true;
    const from = window.location.hash;
    const choices = machineChoices();
    const current = () => live && window.location.hash === from && machineChoices() === choices;
    const scan = startScan(video.current);
    scan.result.then(
      (text) => {
        if (!current()) return;
        const machine = parseAddMachineUri(text.trim());
        if (machine.ok) return navigate({ name: 'confirm-machine', host: machine.host }, { replace: true });
        const payload = parseAddOrgPayload(text);
        if (!payload.ok) return setProblem(payload.reason);
        const org = normalizeTypedOrgUrl(payload.orgUrl);
        if (!org.ok) return setProblem('invalid');
        navigate({ name: 'confirm', url: org.value }, { replace: true });
      },
      (err: unknown) => { if (current()) setProblem(err instanceof ScanError ? err.reason : 'camera_failed'); },
    );
    return () => { live = false; scan.stop(); };
  }, [attempt]);

  const message = problem === null ? null : problemMessage(problem);
  return (
    <Page title={<Trans>Scan a yaran QR code</Trans>} back={{ name: 'welcome' }}>
      {message ? (
        <div role="alert" className="state-card">
          <CameraOffIcon aria-hidden className="size-6 text-muted-foreground" />
          <p>{i18n._(message)}</p>
        </div>
      ) : <video ref={video} className="aspect-square w-full rounded-lg bg-muted object-cover" muted playsInline aria-label={i18n._(msg`Camera preview`)} />}
      {problem !== null && problem !== 'no_camera' && (
        <Button
          className="min-h-12"
          variant="outline"
          onClick={() => {
            setProblem(null);
            setAttempt((n) => n + 1);
          }}
        >
          <Trans>Scan again</Trans>
        </Button>
      )}
      <Button className="min-h-12" variant={message ? 'default' : 'ghost'} onClick={() => navigate({ name: 'enter-url' })}>
        <Trans>Type the org address instead</Trans>
      </Button>
    </Page>
  );
}
