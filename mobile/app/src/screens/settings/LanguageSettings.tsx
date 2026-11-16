/**
 * Language: picks the shell's locale from the bundled catalogs.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/settings/LanguageSettings.tsx
 * ├── src/lib/i18n.ts
 * ├── src/lib/settingsStore.ts
 * ├── src/lib/store.ts
 * ├── src/screens/Page.tsx
 * └── src/screens/settings/SettingRow.tsx
 * External: @lingui/react
 *
 * Used by:
 * src/screens/settings/LanguageSettings.tsx
 * └── src/App.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';

import { LOCALES, activate, isLocale, type Locale } from '../../lib/i18n.ts';
import { settingsStore, updateSettings } from '../../lib/settingsStore.ts';
import { useStore } from '../../lib/store.ts';
import { Page } from '../Page.tsx';
import { RadioGroup } from './SettingRow.tsx';

export function LanguageSettings() {
  const { locale } = useStore(settingsStore);
  const current: Locale = isLocale(locale) ? locale : 'en';
  return (
    <Page title={<Trans>Language</Trans>}>
      <RadioGroup<Locale>
        legend={<Trans>App language</Trans>}
        value={current}
        options={(Object.keys(LOCALES) as Locale[]).map((l) => ({ value: l, label: LOCALES[l] }))}
        onChange={(l) => {
          activate(l);
          void updateSettings({ locale: l });
        }}
      />
    </Page>
  );
}
