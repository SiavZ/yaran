/**
 * ESLint config for the phone app shell, mirroring the web UI's config.
 *
 * Accessibility is enforced by the axe checks in `src/a11y.test.tsx` rather than
 * eslint-plugin-jsx-a11y, which does not support ESLint 10 yet.
 *
 * - `dist` and generated catalogs are ignored.
 *
 * <module-headers:begin>
 * Uses: none
 * External: @eslint/js, eslint, eslint-plugin-react-hooks, globals, typescript-eslint
 *
 * Used by: entry point (read by npm run lint in mobile/app)
 * <module-headers:end>
 */
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist', 'src/locales/**/*.ts', 'src/generated/**']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended, reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
]);
