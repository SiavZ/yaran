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
 * ├── src/screens/machines/machines.test.tsx
 * ├── src/screens/onboarding/onboarding.test.tsx
 * ├── src/screens/screens.test.tsx
 * └── src/screens/settings/settings.test.tsx
 * <module-headers:end>
 */
import { I18nProvider } from '@lingui/react';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';

import { i18n } from '../lib/i18n.ts';

export function renderShell(ui: ReactElement) {
  return render(<I18nProvider i18n={i18n}>{ui}</I18nProvider>);
}
