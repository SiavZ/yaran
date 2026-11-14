#!/usr/bin/env bash
# Publishes a generated cloud deploy tree to its branch: append-only, never backwards.
#
# release-cloud.yml runs this to write the assembled, self-contained Worker tree (07)
# under worker/ on `cloud-deploy` (stable tags, the Deploy button and update checker
# read it, D18) or `cloud-deploy-rc` (release candidates, 19's staging runs). The branch
# is an orphan that never shares history with main; it is created on the first release.
#
# - Refuses unless the tag's version is newer, by semver, than the branch's
#   worker/release.json, so a re-run or an old tag cannot roll a Deploy button back.
# - One commit per release, pushed without force (a racing push fails, never clobbers).
# - Works in a temporary git worktree of the current repository, removed on exit.
#
# Usage: publish_deploy_branch.sh <branch> <tree-dir> <tag> <source-sha> [remote]
#
# <module-headers:begin>
# Uses: none
# External: none
#
# Used by: entry point (release-cloud.yml (deploy-branch, deploy-branch-rc), and test_release_scripts.sh)
# <module-headers:end>

set -euo pipefail

BRANCH="${1:?usage: publish_deploy_branch.sh <branch> <tree-dir> <tag> <source-sha> [remote]}"
TREE="$(cd "${2:?tree dir}" && pwd)"
TAG="${3:?tag}"
SOURCE_SHA="${4:?source sha}"
REMOTE="${5:-origin}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="${TAG#yaran-cloud-v}"

[ -f "$TREE/release.json" ] || { echo "FAIL: $TREE has no release.json" >&2; exit 1; }
built="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).version)' "$TREE/release.json")"
[ "$built" = "$VERSION" ] || { echo "FAIL: release.json says $built but the tag is $TAG" >&2; exit 1; }

WORK="$(mktemp -d)"
rmdir "$WORK"
trap 'git worktree remove --force "$WORK" >/dev/null 2>&1 || true' EXIT

if git ls-remote --exit-code --heads "$REMOTE" "$BRANCH" >/dev/null; then
  git fetch --no-tags --quiet "$REMOTE" "+refs/heads/$BRANCH:refs/remotes/$REMOTE/$BRANCH"
  git worktree add --quiet --detach "$WORK" "refs/remotes/$REMOTE/$BRANCH"
  prev_json="$(git -C "$WORK" show HEAD:worker/release.json 2>/dev/null)" || {
    echo "FAIL: $BRANCH exists but holds no worker/release.json; refusing to guess its version" >&2
    exit 1
  }
  prev="$(printf '%s' "$prev_json" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).version)')"
  if ! node --input-type=module -e '
    const { compareVersions } = await import(process.argv[1]);
    process.exit(compareVersions(process.argv[2], process.argv[3]) > 0 ? 0 : 1);
  ' "$ROOT/tools/release-trains/versions.mjs" "$VERSION" "$prev"; then
    echo "REFUSED: $BRANCH already holds $prev; $TAG is not newer, nothing pushed" >&2
    exit 1
  fi
else
  git worktree add --quiet --detach "$WORK" HEAD
  git -C "$WORK" checkout --quiet --orphan "deploy-$BRANCH-$$"
  git -C "$WORK" rm -r --quiet --cached . >/dev/null
  git -C "$WORK" clean -fdxq
  echo "$BRANCH does not exist yet; creating it as an orphan branch"
fi

rm -rf "$WORK/worker"
cp -R "$TREE" "$WORK/worker"
git -C "$WORK" add -A
git -C "$WORK" -c user.name="github-actions[bot]" \
  -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit --quiet -m "$TAG: generated from $SOURCE_SHA"
git -C "$WORK" push --quiet "$REMOTE" "HEAD:refs/heads/$BRANCH"
echo "Published $TAG to $BRANCH as $(git -C "$WORK" rev-parse HEAD)"
