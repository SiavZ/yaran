# yaran control plane

This repository runs your organization's **yaran control plane** on Cloudflare: a Worker
with a D1 database that signs people in through Cloudflare Access, pairs their machines
and phones, and gives admins a console. It was created by the Deploy to Cloudflare button
from the `cloud-deploy` branch of [SiavZ/yaran](https://github.com/SiavZ/yaran).

## First run

1. **Create the API token first.** Open the
   [token template](https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22c07321b023e944ff818fec44d8203567%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%221e13c5124ca64b72b1969a67e8829049%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22bfe0d8686a584fa680f4c53b5eb0de6d%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22e086da7e2179491d91ee5f35b3ca210a%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%224755a26eedb94da69e1066d98aa820be%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22c8fed203ed3043cba015a93ad1616f1f%22%2C%22type%22%3A%22read%22%7D%5D&name=yaran%20control%20plane)
   in the Cloudflare dashboard. It pre-fills exactly the permissions the control plane uses:
   Cloudflare Tunnel, Access apps and policies, Access organizations and identity providers,
   Workers Scripts, and DNS plus Zone Read. Limit the two zone permissions to the zone you
   will use.
2. **Deploy** with the button, which asks for three secrets:
   - `CF_API_TOKEN`: the token from step 1 (you can also paste it on the setup page);
   - `SETUP_CODE`: at least 24 random characters, for example `openssl rand -base64 24`;
   - `DATA_KEY`: at least 32 random bytes, for example `openssl rand -base64 32`. It encrypts
     the secrets the Worker stores. **Keep a copy**: a lost key means generating new push
     keys and registering every phone again.
3. **Open `https://<worker>.<your-subdomain>.workers.dev/setup`** and enter the setup code.
   The wizard checks the token, reads your Zero Trust team domain, creates the Access
   application, attaches your control-plane hostname, helps you add a sign-in method,
   generates the push keys, and closes setup when you claim admin through the new hostname.
   After that the workers.dev address is turned off and refuses every request.
4. Set the repository variable `YARAN_CONTROL_PLANE_URL` to `https://<your control-plane host>`.

> [!WARNING]
> Until setup closes, the setup code is the only thing guarding the setup page. Use a long
> random code and finish setup soon after deploying. Twenty wrong codes lock setup until
> you change `SETUP_CODE`.

## Updating

The workflow `.github/workflows/yaran-cloud-update.yml` runs weekly. It downloads the
newest `yaran-cloud` release, verifies its SHA-256 and its GitHub provenance attestation,
replaces only the files yaran owns (listed in `upstream-files.json`), keeps your values in
`wrangler.jsonc`, and opens a pull request. Merging it deploys the update; the deploy
script applies database migrations first.

> [!IMPORTANT]
> Turn on **Settings > Actions > General > Allow GitHub Actions to create and approve pull
> requests**, or the workflow fails and says so.

To update by hand: `npm ci && npm run update -- --version X.Y.Z`, then push the branch it
creates and merge it. GitLab: schedule the `yaran-cloud-update` job in `.gitlab-ci.yml`.

Your surface is `wrangler.jsonc` (name, database, routes, vars). Edits to other files are
overwritten by the next update.

## Recovery

If every admin loses access, an account member can make someone admin again:

```bash
npx wrangler d1 execute DB --remote --command "UPDATE users SET role = 'admin', status = 'active' WHERE email = 'you@example.org'"
```

The person must have signed in once. Setup cannot be reopened: it is closed for good.
