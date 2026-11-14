/**
 * The `yaran-cloud` release train: manifest validation, version ordering, release picking.
 *
 * 02 owns the `ReleaseManifest` schema; this wraps its validator and adds what the update
 * checker and the update job both need: SemVer ordering (pre-releases sort before their
 * release), and picking the newest `yaran-cloud-v*` tag from a GitHub releases listing,
 * because `/releases/latest` is repo-wide and would return the app train.
 *
 * - Pure. The deploy tree's `scripts/update/*` import this same file.
 */
import { validate, type ReleaseManifest } from "@yaran/protocol";

export const TRAIN_TAG_PREFIX = "yaran-cloud-v";
export const REPO = "SiavZ/yaran";
export const RAW_MANIFEST_URL = `https://raw.githubusercontent.com/${REPO}/cloud-deploy/worker/release.json`;
export const RELEASES_API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=30`;

export function parseManifest(value: unknown): { ok: true; manifest: ReleaseManifest } | { ok: false; reason: string } {
  const r = validate("ReleaseManifest", value);
  if (r.valid) return { ok: true, manifest: value as ReleaseManifest };
  return { ok: false, reason: r.errors.map((e) => `${e.path || "/"} ${e.message}`).join("; ") };
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Negative when a < b, zero when equal, positive when a > b. Throws on a non-SemVer. */
export function compareSemver(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new Error(`not a version: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  if (pa[4] === pb[4]) return 0;
  if (pa[4] === undefined) return 1;
  if (pb[4] === undefined) return -1;
  return pa[4] < pb[4] ? -1 : 1;
}

export interface GithubRelease {
  tag_name: string;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name: string; browser_download_url: string }[];
}

/** The newest published, non-prerelease `yaran-cloud-v*` release in a listing. */
export function newestTrainRelease(releases: readonly GithubRelease[]): (GithubRelease & { version: string }) | null {
  let best: (GithubRelease & { version: string }) | null = null;
  for (const r of releases) {
    if (r.draft || r.prerelease || !r.tag_name.startsWith(TRAIN_TAG_PREFIX)) continue;
    const version = r.tag_name.slice(TRAIN_TAG_PREFIX.length);
    if (!SEMVER.test(version)) continue;
    if (!best || compareSemver(version, best.version) > 0) best = { ...r, version };
  }
  return best;
}
