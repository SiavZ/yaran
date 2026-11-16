/**
 * Scan QR: the camera preview that reads an add-org QR code.
 *
 * The camera permission is requested by `getUserMedia` (the WebView maps it to the native
 * prompt). A decoded add-org link goes to Confirm org with the URL shown as a chip; any other
 * code says what it was and keeps scanning possible. The typed path is always one tap away.
 *
 * - Stops every camera track when the screen unmounts.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/onboarding/ScanQr.tsx
 * ├── @yaran/qr:src/index.ts
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── src/lib/orgUrl.ts
 * ├── src/lib/route.ts
 * └── src/screens/Page.tsx
 * External: @lingui/core, @lingui/react, react
 *
 * Used by:
 * src/screens/onboarding/ScanQr.tsx
 * ├── src/App.tsx
 * └── src/screens/onboarding/onboarding.test.tsx
 * <module-headers:end>
 */
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { ScanError, parseAddOrgPayload, startScan, type ScanFailure } from '@yaran/qr';
import { Button } from '@yaran/ui-kit/button';
import { useEffect, useRef, useState } from 'react';

import { normalizeTypedOrgUrl } from '../../lib/orgUrl.ts';
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
      return msg`That QR code isn't a yaran org code. Scan the code your admin or yaran cloud login shows.`;
    case 'not_add_org':
    case 'invalid':
      return msg`That yaran code doesn't contain a valid org address.`;
  }
}

export function ScanQr() {
  const { i18n } = useLingui();
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!video.current) return;
    const scan = startScan(video.current);
    scan.result.then(
      (text) => {
        const payload = parseAddOrgPayload(text);
        if (!payload.ok) return setProblem(payload.reason);
        const org = normalizeTypedOrgUrl(payload.orgUrl);
        if (!org.ok) return setProblem('invalid');
        navigate({ name: 'confirm', url: org.value }, { replace: true });
      },
      (err: unknown) => setProblem(err instanceof ScanError ? err.reason : 'camera_failed'),
    );
    return () => scan.stop();
  }, [attempt]);

  const message = problem === null ? null : problemMessage(problem);
  return (
    <Page title={<Trans>Scan the org QR code</Trans>}>
      <video ref={video} className="aspect-square w-full rounded-lg bg-muted object-cover" muted playsInline aria-label={i18n._(msg`Camera preview`)} />
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {i18n._(message)}
        </p>
      )}
      {problem !== null && problem !== 'permission_denied' && problem !== 'no_camera' && (
        <Button
          className="h-10"
          variant="outline"
          onClick={() => {
            setProblem(null);
            setAttempt((n) => n + 1);
          }}
        >
          <Trans>Scan again</Trans>
        </Button>
      )}
      <Button className="h-10" variant="ghost" onClick={() => navigate({ name: 'enter-url' })}>
        <Trans>Type the org address instead</Trans>
      </Button>
    </Page>
  );
}
