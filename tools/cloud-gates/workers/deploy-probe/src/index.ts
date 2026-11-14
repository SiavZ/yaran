/**
 * Deploy probe Worker: reports its D1 schema and secret presence on /v1/meta for gate G11.
 *
 * Pushed alone onto an orphan gate branch under worker/ and deployed by the Deploy to
 * Cloudflare button, which provisions D1, runs the package's deploy script (migrations,
 * then wrangler deploy) and prompts for the three secrets. /v1/meta reads D1 back so the
 * operator can see that provisioning, migration and redeploy all happened.
 *
 * - Fully self-contained: no workspace dependency, only the vendored package by relative path.
 * - Never returns secret values; refusals use the cloud protocol error envelope.
 *
 * <module-headers:begin>
 * Uses:
 * src/index.ts
 * └── src/meta.ts
 *     └── vendor/gate-protocol/index.js
 * External: (none)
 *
 * Used by:
 * src/index.ts
 * └── entry point (Cloudflare Worker, deployed by the Deploy to Cloudflare button for tools/cloud-gates/g11-deploy-button.sh)
 * <module-headers:end>
 */
import { buildMeta, type MetaRow, type SecretEnv } from './meta';

export interface Env extends SecretEnv {
  DB: D1Database;
}

function requestId(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function refuse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, retryable: false }, request_id: requestId() }, { status });
}

/** Applied migration names; an empty list when wrangler's d1_migrations table does not exist. */
async function appliedMigrations(db: D1Database): Promise<string[]> {
  try {
    const { results } = await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>();
    return results.map((r) => r.name);
  } catch {
    return [];
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== '/v1/meta') return refuse(404, 'not_found', 'This probe only answers GET /v1/meta.');
    if (request.method !== 'GET') return refuse(405, 'method_not_allowed', 'Use GET for /v1/meta.');
    let rows: MetaRow[];
    try {
      rows = (await env.DB.prepare('SELECT k, v FROM gate_meta ORDER BY k').all<MetaRow>()).results;
    } catch {
      return refuse(503, 'schema_missing', 'The gate_meta table could not be read; the D1 migrations have not been applied.');
    }
    return Response.json(buildMeta(rows, await appliedMigrations(env.DB), env), { headers: { 'cache-control': 'no-store' } });
  },
} satisfies ExportedHandler<Env>;
