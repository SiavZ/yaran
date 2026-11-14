/**
 * The app's User-Agent token (Design §11): `YaranApp/<version> (<os>; <form>)`, appended
 * after one space to the WebView's default UA in machine-view and sent as the whole UA on
 * native HTTP calls. The visible label wording belongs to Phase 13.
 *
 * - Pure. Rust twin: `yaran_core::cloud::protocol::ua`; pinned by `fixtures/ua/`.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/ua.ts
 * ├── src/index.ts
 * └── test/ua.test.ts
 * <module-headers:end>
 */

export interface YaranAppUa {
  version: string;
  os: "android" | "ios";
  form: "phone" | "tablet";
}

const TOKEN_RE =
  /(?:^| )YaranApp\/([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.-]{1,32})?) \((android|ios); (phone|tablet)\)(?= |$)/;

/** Finds the token anywhere in a UA string. */
export function parseYaranAppUa(ua: string): YaranAppUa | null {
  const m = TOKEN_RE.exec(ua);
  return m ? { version: m[1]!, os: m[2] as YaranAppUa["os"], form: m[3] as YaranAppUa["form"] } : null;
}

/** Builds the token; throws on a value the grammar does not allow. */
export function yaranAppToken(ua: YaranAppUa): string {
  const token = `YaranApp/${ua.version} (${ua.os}; ${ua.form})`;
  if (parseYaranAppUa(token)?.version !== ua.version) throw new Error(`invalid app version ${ua.version}`);
  return token;
}
