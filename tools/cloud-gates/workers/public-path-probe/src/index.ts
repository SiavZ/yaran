/**
 * Public path probe Worker: echoes every request's path and Access JWT presence for gate G8.
 *
 * Deployed on the control-plane-style hostname behind an Access app with public path
 * overrides. Whatever reaches it is reported as JSON, so the gate script can tell an
 * origin 200 (the request got through) from an Access redirect (it did not), and see the
 * path the Worker actually received.
 *
 * - Answers every method and path with 200 and the echo body; it has no other behaviour.
 * - Never echoes header values, only whether the Access headers were present.
 *
 * <module-headers:begin>
 * Uses:
 * src/index.ts
 * └── src/echo.ts
 * External: none
 *
 * Used by: entry point (Cloudflare Worker, deployed by tools/cloud-gates/g08-public-paths.sh)
 * <module-headers:end>
 */
import { echoBody } from './echo';

export default {
  async fetch(request: Request): Promise<Response> {
    return Response.json(echoBody(request.method, request.url, request.headers), {
      headers: { 'cache-control': 'no-store' },
    });
  },
} satisfies ExportedHandler;
