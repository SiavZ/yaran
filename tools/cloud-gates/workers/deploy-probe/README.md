# yaran gate probe: Deploy to Cloudflare button (G11)

This is not part of yaran. It is a throwaway probe for Phase 03 gate G11, which checks
that the Deploy to Cloudflare button can deploy a self-contained Worker from a branch
subdirectory, provision its D1 database, apply migrations from the deploy script, and
prompt for secrets.

`tools/cloud-gates/g11-deploy-button.sh` pushes this directory alone onto an orphan gate
branch under `worker/` and prints the button URL. After a deploy, open `/v1/meta` on the
Worker's `workers.dev` URL: it shows the schema version, the rows the migrations wrote,
the applied migration names, and whether each secret was set (never the values).

Delete the Worker and its D1 database when the gate run is over.
