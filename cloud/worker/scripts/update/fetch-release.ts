/**
 * Fetches and verifies a `yaran-cloud` release tarball for the update job.
 *
 * Resolves the newest (or a named) `yaran-cloud-v*` release with the same rules as the
 * Worker's update checker, downloads the tarball and its `.sha256`, and refuses unless both
 * the published checksum and the manifest's agree with the bytes. On GitHub it also runs
 * `gh attestation verify` against the canonical repository. It refuses to skip past a
 * release's `min_update_from`, naming the stepping-stone version to update to first.
 *
 * - Authenticity is enforced here, where code changes; the Worker's check is advisory.
 *
 * <module-headers:begin>
 * Uses:
 * scripts/update/fetch-release.ts
 * ├── @yaran/protocol:src/index.ts
 * └── src/update/release-manifest.ts
 * External: node:child_process, node:crypto, node:fs, node:os, node:path
 *
 * Used by:
 * scripts/update/fetch-release.ts
 * ├── scripts/update/update.ts
 * └── test/update-job.test.ts
 * <module-headers:end>
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleaseManifest } from "@yaran/protocol";
import { compareSemver, newestTrainRelease, parseManifest, RAW_MANIFEST_URL, RELEASES_API_URL, REPO, TRAIN_TAG_PREFIX, type GithubRelease } from "../../src/update/release-manifest.ts";

export class UpdateRefused extends Error {}

const HEADERS = { "User-Agent": "yaran-cloud-update", Accept: "application/json" };

async function json(fetcher: typeof fetch, url: string): Promise<unknown> {
  const res = await fetcher(url, { headers: HEADERS });
  if (!res.ok) throw new UpdateRefused(`${url} answered HTTP ${res.status}`);
  return res.json();
}

async function manifestAt(fetcher: typeof fetch, url: string): Promise<ReleaseManifest> {
  const parsed = parseManifest(await json(fetcher, url));
  if (!parsed.ok) throw new UpdateRefused(`the release manifest at ${url} is invalid: ${parsed.reason}`);
  return parsed.manifest;
}

/** The manifest of the requested version, or of the newest release on the train. */
export async function resolveRelease(fetcher: typeof fetch, version?: string): Promise<ReleaseManifest> {
  if (!version) {
    try {
      return await manifestAt(fetcher, RAW_MANIFEST_URL);
    } catch {
      // Fall through to the releases API.
    }
  }
  const releases = (await json(fetcher, RELEASES_API_URL)) as GithubRelease[];
  const pick = version ? releases.find((r) => r.tag_name === `${TRAIN_TAG_PREFIX}${version}`) : newestTrainRelease(releases);
  if (!pick) throw new UpdateRefused(version ? `no release ${TRAIN_TAG_PREFIX}${version} exists` : "no yaran-cloud release exists yet");
  const asset = pick.assets?.find((a) => a.name === "release.json");
  if (!asset) throw new UpdateRefused(`release ${pick.tag_name} has no release.json asset`);
  return manifestAt(fetcher, asset.browser_download_url);
}

/** Refuses an update that skips past the release's minimum starting version. */
export function checkStartingPoint(current: string, manifest: ReleaseManifest): "update" | "up_to_date" {
  if (compareSemver(current, manifest.version) >= 0) return "up_to_date";
  if (compareSemver(current, manifest.min_update_from) < 0) {
    throw new UpdateRefused(
      `you run ${current}, but ${manifest.version} can only be applied from ${manifest.min_update_from} or later; update to ${manifest.min_update_from} first (--version ${manifest.min_update_from})`,
    );
  }
  return "update";
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Downloads the tarball and verifies it against the `.sha256` file and the manifest. */
export async function downloadVerified(fetcher: typeof fetch, manifest: ReleaseManifest): Promise<Uint8Array> {
  const res = await fetcher(manifest.tarball.url, { headers: { "User-Agent": HEADERS["User-Agent"] } });
  if (!res.ok) throw new UpdateRefused(`downloading ${manifest.tarball.url} answered HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sumRes = await fetcher(`${manifest.tarball.url}.sha256`, { headers: { "User-Agent": HEADERS["User-Agent"] } });
  if (!sumRes.ok) throw new UpdateRefused(`downloading the checksum answered HTTP ${sumRes.status}`);
  const published = (await sumRes.text()).trim().split(/\s+/)[0]?.toLowerCase();
  const actual = sha256Hex(bytes);
  if (published !== actual || manifest.tarball.sha256 !== actual) {
    throw new UpdateRefused(`the tarball's SHA-256 ${actual} does not match the published ${published} and the manifest's ${manifest.tarball.sha256}; refusing to update`);
  }
  return bytes;
}

/** Writes the tarball to a temp dir, optionally verifies provenance with gh, and extracts it. */
export function extractVerified(bytes: Uint8Array, attest: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "yaran-update-"));
  const tarball = join(dir, "release.tar.gz");
  writeFileSync(tarball, bytes);
  if (attest) execFileSync("gh", ["attestation", "verify", tarball, "--repo", REPO], { stdio: "inherit" });
  const out = join(dir, "tree");
  execFileSync("mkdir", ["-p", out]);
  execFileSync("tar", ["-xzf", tarball, "-C", out, "--no-same-owner"]);
  return out;
}
