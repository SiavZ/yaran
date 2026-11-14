/**
 * The opaque `Page<T>` cursor of the user lists (02 §2): base64url of
 * `<created_at>.<id>`, the keyset position after the last row served.
 *
 * - A cursor that does not decode is refused as `validation_failed`, never guessed at.
 *
 * <module-headers:begin>
 * Uses:
 * src/me/cursor.ts
 * ├── @yaran/protocol:src/index.ts
 * └── src/seams/foundation.ts
 * External: none
 *
 * Used by:
 * src/me/cursor.ts
 * ├── src/me/devices-route.ts
 * └── src/me/machines-route.ts
 * <module-headers:end>
 */
import { b64urlDecode, b64urlEncode, utf8, utf8Decode } from "@yaran/protocol";
import { ApiError } from "../seams/foundation.ts";

export interface PagePosition {
  createdAt: number;
  id: string;
}

const POS_RE = /^(0|[1-9][0-9]{0,11})\.([0-9a-f-]{36})$/;

export function encodeCursor(p: PagePosition): string {
  return b64urlEncode(utf8.encode(`${p.createdAt}.${p.id}`));
}

/** Parses `limit` (1-100, default 50) and `cursor` from a list request's query. */
export function pageQuery(url: URL): { limit: number; after: PagePosition | null } {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!/^[1-9][0-9]{0,2}$/.test(rawLimit ?? "50") || limit > 100) {
    throw new ApiError("validation_failed", "limit must be an integer from 1 to 100.", { errors: [{ path: "/limit", message: "1-100" }] });
  }
  const cursor = url.searchParams.get("cursor");
  if (cursor === null) return { limit, after: null };
  const bytes = cursor.length <= 256 ? b64urlDecode(cursor) : null;
  const m = bytes ? POS_RE.exec(utf8Decode(bytes) ?? "") : null;
  if (!m) throw new ApiError("validation_failed", "cursor is not one this server issued.", { errors: [{ path: "/cursor", message: "unknown cursor" }] });
  return { limit, after: { createdAt: Number(m[1]), id: m[2]! } };
}

/** The next cursor when the page came back full, else null. */
export function nextCursor<T extends { created_at: number; id: string }>(rows: readonly T[], limit: number): string | null {
  const last = rows[rows.length - 1];
  return rows.length === limit && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;
}
