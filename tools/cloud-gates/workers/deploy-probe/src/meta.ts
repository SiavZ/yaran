/**
 * Meta body for gate G11: what the deployed probe reports about its D1 schema and secrets.
 *
 * The operator opens /v1/meta after a Deploy-button run and after a redeploy; the body
 * shows which migrations ran (schema '1' then '2'), the rows they wrote, and whether each
 * Deploy-time secret was filled in. It is built on the vendored gate-protocol package,
 * imported by relative path the way the generated deploy tree imports cloud/protocol.
 *
 * - Secrets are reported as booleans only; an empty string counts as not set.
 * - Pure: takes rows already read from D1, so it is unit-testable in Node.
 *
 * <module-headers:begin>
 * Uses:
 * src/meta.ts
 * └── gate-protocol:index.d.ts
 * External: none
 *
 * Used by:
 * src/meta.ts
 * ├── src/index.ts
 * └── test/meta.test.ts
 * <module-headers:end>
 */
import { metaBody } from '../vendor/gate-protocol/index.js';

export interface SecretEnv {
  CF_API_TOKEN?: string;
  SETUP_CODE?: string;
  DATA_KEY?: string;
}

export interface MetaRow {
  k: string;
  v: string;
}

const present = (v: string | undefined): boolean => typeof v === 'string' && v.length > 0;

export function secretsPresent(env: SecretEnv): { CF_API_TOKEN: boolean; SETUP_CODE: boolean; DATA_KEY: boolean } {
  return { CF_API_TOKEN: present(env.CF_API_TOKEN), SETUP_CODE: present(env.SETUP_CODE), DATA_KEY: present(env.DATA_KEY) };
}

export function buildMeta(rows: MetaRow[], migrations: string[], env: SecretEnv) {
  const schema = rows.find((r) => r.k === 'schema')?.v ?? null;
  const base = metaBody(schema, secretsPresent(env));
  return { protocol: base.protocol, schema: base.schema, rows, migrations, secrets: base.secrets };
}
