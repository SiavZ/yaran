#!/usr/bin/env bash
# G11 — Deploy to Cloudflare button from a branch subdirectory (the generated cloud-deploy layout), with D1 migrations in the deploy script and secret prompts.
#
# Publishes `workers/deploy-probe` as the only content of an orphan gate branch
# of SiavZ/yaran under `worker/` (the layout Phase 07's generated `cloud-deploy`
# branch uses), withholding `0002_gate.sql`, prints the Deploy button URL, and
# walks the operator through the button run on account A, reading the deployed
# probe's `/v1/meta` to check the D1 database was provisioned and migrated and
# which secrets arrived. A second branch adds a `workspace:*` dependency
# (expected to fail, proving why the button targets the generated branch, D18).
# The plain-wrangler variant (`d1 create`, `migrations apply --remote`,
# `deploy --secrets-file`, then 0002) runs unattended and is what Phase 19
# reuses for non-interactive org provisioning.
#
# - Pushing to GitHub happens only after an explicit confirmation, with the
#   operator's own git credentials; the gate branches are deleted at exit.
#
# <module-headers:begin>
# Uses:
# tools/cloud-gates/g11-deploy-button.sh
# ├── tools/cloud-gates/lib/common.sh
# └── tools/cloud-gates/lib/access.sh
# External: curl, git, jq, npx (wrangler)
#
# Used by:
# tools/cloud-gates/g11-deploy-button.sh
# └── entry point (tools/cloud-gates/run.sh G11)
# <module-headers:end>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tools/cloud-gates/lib/common.sh
. "$(dirname "$0")/lib/common.sh"
# shellcheck source=tools/cloud-gates/lib/access.sh
. "$(dirname "$0")/lib/access.sh"

gate_init G11 deploy-button
is_recheck && die "G11 needs an operator at the Deploy button; it is not part of --recheck"
require_tty
require_env GATE_CF_ACCOUNT_ID GATE_CF_API_TOKEN
require_cmd git
PROBE="$HERE/workers/deploy-probe"
[[ -d "$PROBE/node_modules/wrangler" ]] || die "deploy-probe not installed: (cd tools/cloud-gates/workers/deploy-probe && npm ci)"
REMOTE="${GATE_GIT_REMOTE_URL:-https://github.com/SiavZ/yaran.git}"
BRANCH="${GATE_DEPLOY_BRANCH:-cloud-gates/deploy-probe}"
REPO_WEB="${REMOTE%.git}"

meta() { curl -sS --max-time 15 "$1/v1/meta"; }
# tree <dir> [with-0002]: the probe as an isolated subdirectory app, no node_modules.
tree() {
  mkdir -p "$1/worker"
  (cd "$PROBE" && tar cf - --exclude node_modules --exclude .wrangler .) | (cd "$1/worker" && tar xf -)
  [[ "${2:-}" == with-0002 ]] || rm -f "$1/worker/migrations/0002_gate.sql"
}
publish() { # <dir> <branch> <message>
  git -C "$1" init -q -b main && git -C "$1" add -A &&
    git -C "$1" -c user.name="yaran gates" -c user.email="gate@example.invalid" commit -qm "$3" &&
    git -C "$1" push -qf "$REMOTE" "HEAD:refs/heads/$2"
  cleanup_push "git -C '$1' push -q '$REMOTE' --delete '$2'"
}

step "plain-wrangler variant (unattended reproduction)"
P="$RUN_TMP/plain"; tree "$P"; ln -s "$PROBE/node_modules" "$P/worker/node_modules"
DB_ID="$(cf_api POST "$(cf_acct)/d1/database" "$(jq -nc --arg n "yaran-gate-g11-$RUN_ID" '{name:$n}')" | jq -r '.result.uuid // empty')"
[[ -n "$DB_ID" ]] || die "d1 database create failed"
cleanup_push "cf_api DELETE '$(cf_acct)/d1/database/$DB_ID'"
perl -0pi -e "s/(\"database_name\": \"yaran-gate-deploy-probe\",)/\$1\n      \"database_id\": \"$DB_ID\",/" "$P/worker/wrangler.jsonc"
NAME="yaran-gate-deploy-probe-$RUN_ID"
SEC="$RUN_TMP/secrets.json"
(umask 077; jq -nc --arg a "$(head -c 24 /dev/urandom | base64)" --arg b "$(head -c 24 /dev/urandom | base64)" --arg c "$(head -c 24 /dev/urandom | base64)" \
  '{CF_API_TOKEN:$a, SETUP_CODE:$b, DATA_KEY:$c}' >"$SEC")
wrangler_run "$P/worker" d1 migrations apply DB --remote 2>&1 | record wrangler-plain || die "migrations apply failed"
wrangler_run "$P/worker" deploy --name "$NAME" --secrets-file "$SEC" 2>&1 | record wrangler-plain || die "deploy --secrets-file failed"
cleanup_push "wrangler_run '$P/worker' delete --name '$NAME' --force"
URL="$(workers_dev_url "$NAME")"
wait_until 120 bash -c "curl -sf '$URL/v1/meta' >/dev/null" || die "$URL/v1/meta never answered"
m="$(meta "$URL")"; printf '%s\n' "$m" | record meta-plain
check "plain: D1 migrated to schema 1" 1 "$(jq -r .schema <<<"$m")"
check "plain: all three secrets arrived" "true true true" "$(jq -r '.secrets | "\(.CF_API_TOKEN) \(.SETUP_CODE) \(.DATA_KEY)"' <<<"$m")"
cp "$PROBE/migrations/0002_gate.sql" "$P/worker/migrations/"
wrangler_run "$P/worker" d1 migrations apply DB --remote 2>&1 | record wrangler-plain || die "0002 apply failed"
check "plain: 0002 applied on re-run" 2 "$(jq -r .schema <<<"$(meta "$URL")")"

step "Deploy button from the orphan gate branch"
log "This pushes branch $BRANCH (only worker/, migrations 0001 only) to $REMOTE with your git credentials."
if [[ "$(_tty_read 0 "push $BRANCH and $BRANCH-workspace to $REMOTE now? [y/N]" || true)" != y ]]; then
  skip "Deploy button run and workspace variant" "operator declined the push"
  exit 0
fi
B="$RUN_TMP/button"; tree "$B"; publish "$B" "$BRANCH" "Deploy-button probe for gate G11 (0001 only)" || die "git push failed"
BTN="https://deploy.workers.cloudflare.com/?url=$REPO_WEB/tree/$BRANCH/worker"
observe "Deploy button URL" "$BTN"
checklist "G11 Deploy button run (account A)" <<EOF
1. Open $BTN while signed in to account A.
2. At the prompts: a throwaway CF_API_TOKEN, SETUP_CODE left BLANK (does the form accept it?),
   a throwaway DATA_KEY. Note how the binding descriptions from package.json render.
3. After the build: check the clone's root is the subdirectory, its wrangler.jsonc now has a
   database_id, and the build log shows "migrations apply" running.
4. Paste the deployed workers.dev URL below.
5. Then add worker/migrations/0002_gate.sql (copy from tools/cloud-gates/workers/deploy-probe/migrations/)
   to YOUR clone, push, and wait for Workers Builds to redeploy.
EOF
confirm_check "clone root is the subdirectory" "is the clone's root the worker/ subdirectory?"
confirm_check "cloned wrangler.jsonc contains a database_id" "does the cloned wrangler.jsonc contain a database_id?"
confirm_check "build log shows migrations applied by the deploy script" "does the build log show migrations applied?"
confirm_check "secrets prompted with the package.json descriptions" "were the three secrets prompted with their descriptions?"
ask BLANK_SECRET "was a blank SETUP_CODE accepted? (yes/no)" || true
if ask DEPLOYED_URL "deployed workers.dev URL (https://…)"; then
  m="$(meta "$DEPLOYED_URL")"; printf '%s\n' "$m" | record meta-button
  check "button: D1 provisioned and migrated (schema 1)" 1 "$(jq -r .schema <<<"$m")"
  observe "button: secrets present" "$(jq -c .secrets <<<"$m")"
  pause "push the 0002 migration to your clone and wait for the redeploy"
  wait_until 600 bash -c "[[ \$(curl -s '$DEPLOYED_URL/v1/meta' | jq -r .schema) == 2 ]]" || true
  check "button: a push to the clone redeploys and applies 0002" 2 "$(jq -r .schema <<<"$(meta "$DEPLOYED_URL")")"
else skip "button deploy checks" "no deployed URL"; fi

step "workspace:* variant (expected to fail)"
W="$RUN_TMP/workspace"; tree "$W"
mkdir -p "$W/sibling" && printf '{"name":"gate-sibling","version":"0.0.0","main":"index.js"}\n' >"$W/sibling/package.json"
printf 'export const x = 1;\n' >"$W/sibling/index.js"
jq '.dependencies = {"gate-sibling": "workspace:*"}' "$W/worker/package.json" >"$W/p" && mv "$W/p" "$W/worker/package.json"
publish "$W" "$BRANCH-workspace" "Deploy-button probe for gate G11 (workspace dependency)" || die "git push failed"
observe "workspace variant URL" "https://deploy.workers.cloudflare.com/?url=$REPO_WEB/tree/$BRANCH-workspace/worker"
confirm_check "workspace:* variant fails to deploy (why the button targets the generated cloud-deploy branch)" "did the workspace variant fail?"
pause "delete the Workers, D1 databases and GitHub clones the button created on account A (the gate deletes its own branches at exit)"
