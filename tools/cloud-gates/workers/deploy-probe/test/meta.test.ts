/**
 * Meta body tests: schema, rows, migrations and secret booleans as /v1/meta reports them.
 *
 * Exercises the vendored gate-protocol import too, so a broken relative import of the
 * pre-built package fails here before it fails a Deploy-button build.
 *
 * - Pure: no D1, no Worker runtime.
 *
 * <module-headers:begin>
 * Uses:
 * test/meta.test.ts
 * └── src/meta.ts
 *     └── vendor/gate-protocol/index.js
 * External: vitest
 *
 * Used by:
 * test/meta.test.ts
 * └── entry point (vitest)
 * <module-headers:end>
 */
import { describe, expect, it } from 'vitest';
import { buildMeta, secretsPresent } from '../src/meta';

describe('buildMeta', () => {
  it('reports schema 2 after the second migration, with rows and migration names', () => {
    const rows = [
      { k: 'gate', v: '0002-applied' },
      { k: 'schema', v: '2' },
    ];
    const body = buildMeta(rows, ['0001_init.sql', '0002_gate.sql'], { CF_API_TOKEN: 'secret-value', SETUP_CODE: '', DATA_KEY: 'k' });
    expect(body).toEqual({
      protocol: 1,
      schema: '2',
      rows,
      migrations: ['0001_init.sql', '0002_gate.sql'],
      secrets: { CF_API_TOKEN: true, SETUP_CODE: false, DATA_KEY: true },
    });
    expect(JSON.stringify(body)).not.toContain('secret-value');
  });

  it('reports a null schema when the row is missing', () => {
    expect(buildMeta([], [], {}).schema).toBeNull();
  });

  it('treats unset and empty secrets as absent', () => {
    expect(secretsPresent({})).toEqual({ CF_API_TOKEN: false, SETUP_CODE: false, DATA_KEY: false });
  });
});
