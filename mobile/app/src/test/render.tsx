/**
 * Test helper: renders a shell component inside the i18n provider.
 *
 * <module-headers:begin>
 * Uses:
 * src/test/render.tsx
 * └── src/lib/i18n.ts
 * External: @lingui/react, @testing-library/react, react
 *
 * Used by:
 * src/test/render.tsx
 * ├── src/a11y.test.tsx
 * ├── src/approvalNavigation.test.tsx
 * ├── src/continuations.test.tsx
 * ├── src/explicitOpen.test.tsx
 * ├── src/launch.test.tsx
 * ├── src/modalNavigation.test.tsx
 * ├── src/orgStaging.test.tsx
 * ├── src/orgStagingSettle.test.tsx
 * ├── src/reopenPriority.test.tsx
 * ├── src/screens/machines/approval.test.tsx
 * ├── src/screens/machines/direct.test.tsx
 * ├── src/screens/machines/instanceChanged.test.tsx
 * ├── src/screens/machines/machines.test.tsx
 * ├── src/screens/machines/upgradeRequired.test.tsx
 * ├── src/screens/onboarding/onboarding.test.tsx
 * ├── src/screens/onboarding/scannerFailures.test.tsx
 * ├── src/screens/screens.test.tsx
 * ├── src/screens/settings/notificationPreferences.test.tsx
 * ├── src/screens/settings/settings.test.tsx
 * └── src/shareBatch.test.tsx
 * <module-headers:end>
 */
import { I18nProvider } from '@lingui/react';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';

import { i18n } from '../lib/i18n.ts';

export function renderShell(ui: ReactElement) {
  return render(<I18nProvider i18n={i18n}>{ui}</I18nProvider>);
}
