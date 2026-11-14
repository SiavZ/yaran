/**
 * The daily update check for the `yaran-cloud-v*` train, cached as 02's `UpdateStatus`.
 *
 * Runs from the shared one-minute cron but does real work at most once a day. It reads
 * the release manifest from the `cloud-deploy` branch on raw.githubusercontent.com first
 * (not subject to the REST API's 60-an-hour limit), and falls back to the releases API
 * filtered to this train. A failure is stored as an error with the time it happened and
 * the last known latest version kept; it is never stored as "up to date".
 *
 * - The manifest is advisory: authenticity is enforced by the update job, where code changes.
 *
 * <module-headers:begin>
 * Uses:
 * src/update/update-checker.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/admin/ports.ts
 * ├── src/admin/settings-store.ts
 * ├── src/admin/wire-time.ts
 * └── src/update/release-manifest.ts
 * External: none
 *
 * Used by:
 * src/update/update-checker.ts
 * ├── src/admin-api/routes.ts
 * ├── src/admin/scheduled-jobs.ts
 * ├── src/console/admin-routes.ts
 * └── test/update-checker.test.ts
 * <module-headers:end>
 */
import type { UpdateStatus } from "@yaran/protocol";
import type { D1Like } from "../admin/ports.ts";
import { readKey, writeKeys } from "../admin/settings-store.ts";
import { wireTime } from "../admin/wire-time.ts";
import { compareSemver, newestTrainRelease, parseManifest, RAW_MANIFEST_URL, RELEASES_API_URL, type GithubRelease } from "./release-manifest.ts";

export const STATUS_KEY = "update_status";
export const CHECK_INTERVAL_MS = 24 * 3_600_000;

export interface CheckerDeps {
  db: D1Like;
  fetch: typeof fetch;
  now(): Date;
  workerVersion: string;
}

interface Latest {
  version: string;
  notes_url: string | null;
  security: boolean;
}

const HEADERS = { "User-Agent": "yaran-cloud-update-check", Accept: "application/json" };

async function fromRaw(deps: CheckerDeps): Promise<Latest> {
  const res = await deps.fetch(RAW_MANIFEST_URL, { headers: HEADERS });
  if (!res.ok) throw new Error(`release manifest answered HTTP ${res.status}`);
  const parsed = parseManifest(await res.json());
  if (!parsed.ok) throw new Error(`release manifest is invalid: ${parsed.reason}`);
  return { version: parsed.manifest.version, notes_url: parsed.manifest.notes_url, security: parsed.manifest.security };
}

async function fromApi(deps: CheckerDeps): Promise<Latest> {
  const res = await deps.fetch(RELEASES_API_URL, { headers: { ...HEADERS, Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub releases API answered HTTP ${res.status}`);
  const newest = newestTrainRelease((await res.json()) as GithubRelease[]);
  if (!newest) throw new Error("no yaran-cloud release found");
  const asset = newest.assets?.find((a) => a.name === "release.json");
  if (asset) {
    const m = await deps.fetch(asset.browser_download_url, { headers: HEADERS });
    const parsed = m.ok ? parseManifest(await m.json()) : null;
    if (parsed?.ok) return { version: parsed.manifest.version, notes_url: parsed.manifest.notes_url, security: parsed.manifest.security };
  }
  return { version: newest.version, notes_url: newest.html_url, security: false };
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/** Checks now, whatever the clock says; stores and returns the status. */
export async function checkForUpdate(deps: CheckerDeps): Promise<UpdateStatus> {
  const prev = await readKey<UpdateStatus>(deps.db, STATUS_KEY);
  const checked_at = wireTime(deps.now());
  let latest: Latest;
  try {
    latest = await fromRaw(deps).catch(async (rawError: unknown) => {
      try {
        return await fromApi(deps);
      } catch (apiError) {
        throw new Error(`${reason(rawError)}; fallback: ${reason(apiError)}`);
      }
    });
  } catch (e) {
    const status: UpdateStatus = {
      current: deps.workerVersion,
      latest: prev?.latest ?? null,
      notes_url: prev?.notes_url ?? null,
      update_available: prev?.update_available ?? false,
      security: prev?.security ?? false,
      checked_at,
      error: reason(e),
    };
    await writeKeys(deps.db, { [STATUS_KEY]: status }, "system", deps.now());
    return status;
  }
  const newer = compareSemver(latest.version, deps.workerVersion) > 0;
  const status: UpdateStatus = { current: deps.workerVersion, latest: latest.version, notes_url: latest.notes_url, update_available: newer, security: newer && latest.security, checked_at, error: null };
  await writeKeys(deps.db, { [STATUS_KEY]: status }, "system", deps.now());
  return status;
}

/** The cron entry: checks only when the last check is more than a day old. */
export async function maybeCheckForUpdate(deps: CheckerDeps): Promise<UpdateStatus | null> {
  const prev = await readKey<UpdateStatus>(deps.db, STATUS_KEY);
  if (prev && deps.now().getTime() - Date.parse(prev.checked_at) < CHECK_INTERVAL_MS) return null;
  return checkForUpdate(deps);
}

export async function readUpdateStatus(deps: CheckerDeps): Promise<UpdateStatus> {
  return (
    (await readKey<UpdateStatus>(deps.db, STATUS_KEY)) ?? {
      current: deps.workerVersion,
      latest: null,
      notes_url: null,
      update_available: false,
      security: false,
      checked_at: wireTime(0),
      error: "not checked yet",
    }
  );
}
