/**
 * Diagnostics: the sanitized local log, previewed in the shell before Export… shares it.
 *
 * The native core strips query strings, JWT-shaped strings, cookie and authorization values
 * and terminal escapes before keeping a line; hostnames and machine names stay, and the
 * screen says so before anything leaves the phone (T51).
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/settings/Diagnostics.tsx
 * ├── @yaran/secure-store:src/index.ts
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── src/lib/notify.ts
 * └── src/screens/Page.tsx
 * External: @lingui/react, react
 *
 * Used by:
 * src/screens/settings/Diagnostics.tsx
 * ├── src/App.tsx
 * └── src/screens/settings/settings.test.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';
import { Diagnostics as DiagnosticsLog } from '@yaran/secure-store';
import { Button } from '@yaran/ui-kit/button';
import { useEffect, useState } from 'react';

import { notify } from '../../lib/notify.ts';
import { Page } from '../Page.tsx';

export function Diagnostics() {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    DiagnosticsLog.read().then(
      (r) => setText(r.text),
      () => setText(''),
    );
  }, []);

  async function exportLog() {
    const { outcome } = await DiagnosticsLog.export().catch(() => ({ outcome: 'failed' as const }));
    if (outcome === 'shared') notify('success', <Trans>The diagnostics log was handed to the app you picked.</Trans>);
    else if (outcome === 'failed') notify('error', <Trans>Couldn't open the share sheet for the diagnostics log.</Trans>);
  }

  return (
    <Page title={<Trans>Diagnostics</Trans>}>
      <p className="text-sm text-muted-foreground">
        <Trans>
          This log never includes sign-in tokens, cookies or link parameters, but it does include org and machine host names
          and machine names. Check it before you share it.
        </Trans>
      </p>
      <pre aria-label="Diagnostics log" className="max-h-96 overflow-auto rounded-lg border border-border bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
        {text === null ? '' : text === '' ? <Trans>The log is empty.</Trans> : text}
      </pre>
      <Button className="h-10" variant="outline" disabled={!text} onClick={() => void exportLog()}>
        <Trans>Export…</Trans>
      </Button>
    </Page>
  );
}
