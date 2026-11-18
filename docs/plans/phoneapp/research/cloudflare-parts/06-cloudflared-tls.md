# 06: cloudflared as a supervised child, and what Cloudflare sees of the traffic

Researched 2026-11-14. Source code was read from a shallow clone of tag `2026.11.0`
(commit b0297f0b24c60a4cef743b7b878e2da3798cb839). Code links below use the
`SRC` prefix, which stands for `https://github.com/cloudflare/cloudflared/blob/2026.11.0/`.
Line numbers refer to that tag.

## Part A: cloudflared

### 1. License, versioning, cadence, support window

1.1 **License: Apache-2.0.** The GitHub API reports `spdx_id: Apache-2.0`, and so does the Homebrew formula.
    https://github.com/cloudflare/cloudflared/blob/2026.11.0/LICENSE ,
    https://formulae.brew.sh/api/formula/cloudflared.json

1.2 **Versioning: calendar `YYYY.M.N`, git tags carry no `v` prefix** (recent tags: `2026.11.0`, `2026.10.7`, `2026.10.6`, ...). N counts patch releases within the month. The month number has no zero padding (`2026.7.3`).
    `gh api repos/cloudflare/cloudflared/tags`, SRC`RELEASE_NOTES`

1.3 **Latest release: `2026.11.0`, published 2026-11-12T12:23:45Z.** It contains a security fix, "VULN-170057: Don't bypass access with matrix parameters", and moves the build to Go 1.27.4.
    https://github.com/cloudflare/cloudflared/releases/tag/2026.11.0 , SRC`RELEASE_NOTES` lines 1-5

1.4 **Cadence: frequent and irregular.** There were 31 releases in calendar 2026 so far (2026.1.0 through 2026.11.0; there is no 2026.4.x), 18 in 2025, and 30 GitHub releases in the 12 months to 2026-11-14. October 2026 alone had eight (2026.10.0 to 2026.10.7). Several of them are security fixes (`VULN-*` entries).
    SRC`RELEASE_NOTES` ; `gh api repos/cloudflare/cloudflared/releases`

1.5 **Support policy: one year.** Docs: "Cloudflare supports versions of `cloudflared` that are within one year of the most recent release." The README adds: "Breaking changes unrelated to feature availability may be introduced that will impact versions released more than one year ago."
    https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/ ,
    SRC`README.md` (section "Deprecated versions")

1.6 **Breaking-change policy for the CLI.** The README says: "Removal of CLI flags, environment variables, configuration keys, or commands is a breaking change. Such removals must be announced in the Cloudflare Tunnel changelog before the release that removes them." That gives a supervisor that passes flags some protection.
    SRC`README.md` (section "Breaking Changes"), https://developers.cloudflare.com/changelog/product/tunnel/

### 2. Binaries, checksums, signatures, packages

2.1 **Release assets for 2026.11.0:**
    - macOS: `cloudflared-darwin-amd64.tgz`, `cloudflared-darwin-arm64.tgz`, `cloudflared-amd64.pkg`, `cloudflared-arm64.pkg`
    - Linux raw binaries: `cloudflared-linux-amd64`, `-arm64`, `-arm`, `-armhf`, `-386`, plus `cloudflared-fips-linux-amd64`
    - `.deb` packages: amd64, arm64, arm, armhf, 386, fips-amd64
    - `.rpm` packages: x86_64, aarch64, arm, armhf, 386, fips-x86_64
    - Windows: .exe and .msi for 386 and amd64
    https://github.com/cloudflare/cloudflared/releases/tag/2026.11.0

2.2 **Checksums are SHA-256 and appear only in the release-notes body.** The body has a "### SHA256 Checksums:" block with one `name: hex` line per asset. There is no separate `SHA256SUMS` asset, so a downloader has to parse the release body (`gh api .../releases/latest --jq .body`). Example: `cloudflared-darwin-arm64.tgz: 97e24268d9704a570fab276293028f3580ae2c7d5d2678621a4809e90f776a5e`.
    https://github.com/cloudflare/cloudflared/releases/tag/2026.11.0

2.3 **Signatures:**
    - No detached signature files (.sig, .asc, cosign, SLSA) are attached to GitHub releases (asset list in 2.1).
    - macOS: CI signs with a "Developer ID Application" certificate using `codesign ... --options runtime --timestamp` (hardened runtime). SRC`.ci/scripts/mac/build.sh` lines 135-183
    - **UNVERIFIED:** whether the macOS binaries are also notarized. No `notarytool` or `stapler` call was found in that script.
    - Linux: the .deb and .rpm repositories on pkg.cloudflare.com are GPG-signed. The repo file sets `gpgcheck=1` with `gpgkey=https://pkg.cloudflare.com/cloudflare-main.gpg`, and the apt repos are signed through reprepro `SignWith`. SRC`release_pkgs.py` lines 63-143, SRC`.ci/release.gitlab-ci.yml` lines 43-69
    - The docs downloads page gives no guidance on verifying checksums or signatures. https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/

2.4 **Homebrew:** `brew install cloudflared`. The formula is at `2026.11.0`, licensed Apache-2.0, and is a core formula with bottles. Bottles exist for `arm64_golden_gate`, `arm64_tahoe`, `arm64_sequoia`, `arm64_linux` and `x86_64_linux`. **There is no Intel macOS bottle**, so Intel Macs build from source or use the GitHub tgz.
    https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/ ,
    https://formulae.brew.sh/api/formula/cloudflared.json

2.5 **Package repositories (pkg.cloudflare.com):**
    - APT: the key is at `https://pkg.cloudflare.com/cloudflare-main.gpg`, and the repo line is `deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main`.
    - RPM: the repo file is at `https://pkg.cloudflare.com/cloudflared.repo`.
    - Note: Cloudflare rolled its signing key on 30 Oct 2025, and the old keys were to be removed 30 Apr 2026.
    https://pkg.cloudflare.com/

2.6 **Package installs disable self-update.** A package install writes the marker `/usr/local/etc/cloudflared/.installedFromPackageManager` (path from `config.DefaultUnixConfigLocation`), or the build sets `BuiltForPackageManager`. Either one turns self-update off. See 5.4.
    SRC`cmd/cloudflared/updater/update.go` lines 28-30, 283-298

### 3. `tunnel run` flags (source is authoritative)

Flag-name constants are in SRC`cmd/cloudflared/flags/flags.go`. Definitions are in SRC`cmd/cloudflared/tunnel/cmd.go`, SRC`cmd/cloudflared/tunnel/subcommands.go` and SRC`cmd/cloudflared/cliutil/logger.go`. Docs table: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/

| Flag | Env var | Default (source) | Notes / source |
|---|---|---|---|
| `--token` | `TUNNEL_TOKEN` | none | "Also takes precedence over token-file". subcommands.go:127-131 |
| `--token-file` | `TUNNEL_TOKEN_FILE` | none | Reads the file and trims whitespace. subcommands.go:132-136, 769-779. **Added in 2025.4.0** ("feat: Adds a new command line for tunnel run for token file", RELEASE_NOTES line 336 under the 2025.4.0 header); the docs also say it "requires cloudflared version 2025.4.0 or later" |
| `--no-autoupdate` | `NO_AUTOUPDATE` | false | cmd.go:925-929 |
| `--autoupdate-freq` | (none) | 24h (`DefaultCheckUpdateFreq`) | cmd.go:919-922; update.go:25 |
| `--metrics` | `TUNNEL_METRICS` | `localhost:0`, which means try `localhost:20241`..`20245`, then a random port | cmd.go:939-950; metrics/metrics.go:31-53, 149-178 |
| `--loglevel` | `TUNNEL_LOGLEVEL` | `info`; allowed values {debug, info, warn, error, fatal} | cliutil/logger.go:28-32. The docs warn that `debug` logs request and response headers |
| `--logfile` | `TUNNEL_LOGFILE` | none | logger.go:41-44. The docs say cloudflared does not rotate this file |
| `--log-directory` | `TUNNEL_LOGDIRECTORY` | none | logger.go:47-50 |
| `--output` (log format) | `TUNNEL_MANAGEMENT_OUTPUT`, `TUNNEL_LOG_OUTPUT` | `default`; `json` also available | logger.go:18-21. **Useful for machine-parsing child logs** |
| `--protocol` | `TUNNEL_TRANSPORT_PROTOCOL` | `auto` (QUIC first, falls back to HTTP/2); `quic`, `http2` | subcommands.go:144-150 (hidden flag); connection/protocol.go:10,20 |
| `--edge-ip-version` | `TUNNEL_EDGE_IP_VERSION` | **`auto`** in source; {4, 6, auto} | cmd.go:680-684. **The docs table says default `4`. That is a doc/source discrepancy, and the source wins** |
| `--post-quantum` | `TUNNEL_POST_QUANTUM` | false | subcommands.go:152-156. The docs say it forces post-quantum key agreement on QUIC with no fallback and is not supported with `http2` |
| `--grace-period` | `TUNNEL_GRACE_PERIOD` | 30s, **max 3m** (`connection.MaxGracePeriod`); a larger value is an error | cmd.go:825-829; configuration.go:288-294; connection/connection.go:26 |
| `--retries` | `TUNNEL_RETRIES` | 5 | cmd.go:775-779 |
| `--management-diagnostics` | `TUNNEL_MANAGEMENT_DIAGNOSTICS` | **true** | Exposes /debug/pprof, /metrics etc. over the remote management service. cmd.go:890-893. **Not on the docs run-parameters page** |
| `--label` | (none) | "" | Connector label. Without it, the dashboard identifies a connector by hostname plus connector UUID. cmd.go:820-822. **Not on the docs page** |
| `--pidfile` | `TUNNEL_PIDFILE` | none | Writes the PID "after first successful connection". cmd.go:952-955 |
| `--no-prechecks` | `TUNNEL_NO_PRECHECKS` | false | Skips connectivity pre-checks at startup. cmd.go:932-936 |
| `--ha-connections` | (none) | 4 (hidden) | cmd.go:782-784 |

3.1 **Token handling. Use the environment variable or `--token-file`, never `--token` on argv.** Cloudflare's own service installers moved from `--token` to `--token-file` in 2026 and filed this as security fixes:
    - Linux service, VULN-118896, 2026.7.2
    - macOS service, VULN-118896, 2026.7.2
    - Windows service, VULN-143514, 2026.7.3
    Arguments on argv are visible to other local users through `ps`. Cloudflare also removed `cmdline` from the metrics server's debug endpoints because it "publish[es] os.Args and thus secrets such as tunnel tokens".
    SRC`RELEASE_NOTES` lines 126-136; SRC`metrics/metrics.go` lines 101-112; SRC`cmd/cloudflared/common_service.go` line 79

3.2 **The token is redacted in cloudflared's own logs and diagnostics.** The values of `token` and `credentials-contents` (flag and env var) are replaced by `*****`. `token-file` is not redacted, but its value is only a path.
    SRC`cmd/cloudflared/tunnel/configuration.go` lines 36-46, 60-100

3.3 **An invalid token fails fast.** It returns the usage error "Provided Tunnel token is not valid.", which exits with code -1, seen as 255. See 5.1.
    SRC`cmd/cloudflared/tunnel/subcommands.go` lines 781-785

### 4. Metrics server endpoints

The routes are registered in SRC`metrics/metrics.go` lines 68-99 and SRC`diagnostic/handlers.go` lines 111-114.

4.1 **`/ready`**:
    - Returns HTTP 200 when at least one edge connection is active, otherwise 503.
    - The body is JSON `{"status":<code>,"readyConnections":<n>,"connectorId":"<uuid>"}`.
    - The handler comment says it is "Intended for k8s readiness checks."
    - There is also a `cloudflared tunnel ready --metrics <addr>` subcommand that calls /ready and exits non-zero on anything but 200. It requires `--metrics`.
    SRC`metrics/readiness.go` lines 13-60; SRC`cmd/cloudflared/tunnel/subcommands.go` lines 467-504.
    - **The docs metrics page does not mention /ready or /healthcheck.** The source is the only authority here.
    https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/monitor-tunnels/metrics/

4.2 **`/metrics`**: Prometheus exposition through `promhttp.Handler()`. The docs list roughly 50 metrics, for example `cloudflared_tunnel_total_requests`, plus Go runtime metrics. `build_info{version=...}` is registered.
    SRC`metrics/metrics.go` lines 75, 218-229; docs metrics page above

4.3 **`/healthcheck`**: always returns `OK\n`. It is a liveness check only, not a sign that the tunnel is connected.
    SRC`metrics/metrics.go` lines 76-78

4.4 **`/quicktunnel`**: returns `{"hostname":"..."}` for TryCloudflare quick tunnels. For a named or token tunnel the hostname is empty.
    SRC`metrics/metrics.go` lines 82-84

4.5 **Other routes on the same listener:**
    - `/config`: the versioned remote ingress configuration as JSON.
    - `/diag/configuration`: CLI flags with secrets redacted, plus the uid.
    - `/diag/tunnel`, `/diag/system`, `/diag/precheck`
    - `/debug/pprof/*` and `GET /debug/vars`: an allowlist that is memstats only since 2026.10.4.
    The listener has no authentication. **On loopback, any local user can read the ingress config and profiles.** That matters on multi-user hosts.
    SRC`metrics/metrics.go` lines 85-124; SRC`diagnostic/consts.go` lines 18-25; SRC`RELEASE_NOTES` line 28

4.6 **Default address and port range.** Outside containers the default binds `localhost:20241` through `20245`, the first one free, then a random port. In "virtual" (container) builds it binds `0.0.0.0` on the same ports. The log line "Starting metrics server on <addr>/metrics" reports the address actually chosen. **A supervisor should pass an explicit `--metrics 127.0.0.1:<port>`** so it does not race other cloudflared instances for 20241-20245.
    SRC`metrics/metrics.go` lines 28-53, 144-178, 196; docs metrics page above

### 5. Exit codes, signals, autoupdate, privileges, ICMP

5.1 **Exit codes, from source:**
    - Usage or validation errors exit with -1, which the process sees as 255. SRC`cmd/cloudflared/cliutil/errors.go` lines 25-37
    - Any other returned error exits with 1. Same file; SRC`cmd/cloudflared/cliutil/handler.go` line 36
    - Self-update succeeded: exit **11**. Self-update failed: exit **10**. SRC`cmd/cloudflared/updater/update.go` lines 41-70
    - **Inferred, not tested:** a graceful shutdown on a signal returns nil from `waitToShutdown`, so the exit code is 0. SRC`cmd/cloudflared/tunnel/cmd.go` lines 565-600
    - No official doc lists exit codes. **UNVERIFIED** beyond reading the source.

5.2 **Signals:**
    - SIGTERM and SIGINT both start a graceful shutdown. The log says "Initiating graceful shutdown due to signal ...". SRC`cmd/cloudflared/tunnel/signal.go` lines 12-23
    - The flag help says cloudflared "will stop accepting new requests, wait for in-progress requests to terminate, then shutdown. Waiting for in-progress requests will timeout after this grace period, or when a second SIGTERM/SIGINT is received." The default period is 30s, the maximum 3m. SRC`cmd/cloudflared/tunnel/cmd.go` lines 825-829
    - The handler calls `signal.Stop` after the first signal, so a second signal gets Go's default disposition and terminates the process immediately. That matches the help text.
    - **Supervisor advice:** send SIGTERM, wait slightly longer than `--grace-period`, then SIGKILL. Or pass a short `--grace-period` such as 5s for snappy stops.

5.3 **Autoupdate stays on in a supervised child unless you turn it off.** `supportAutoUpdate` disables updates only in these cases:
    - On Windows.
    - When a package-manager marker is present or the build is a package-manager build.
    - When **stdout is a TTY** (`term.IsTerminal(os.Stdout)`).
    SRC`cmd/cloudflared/updater/update.go` lines 271-303

    A child whose stdout is piped is not a TTY, so a raw GitHub binary self-updates every 24h by default:
    - It downloads from `update.argotunnel.com` / github.com.
    - It replaces its own binary.
    - It exits with **code 11**. Under SysV it re-execs itself first.
    SRC`update.go` lines 241-268; firewall doc below lists the update hosts

    **Pass `--no-autoupdate` (or `NO_AUTOUPDATE=true`) and manage versions yourself.** Cloudflare's own container images set `ENV NO_AUTOUPDATE=true` (TUN-11051, 2026.10.6). SRC`Dockerfile.amd64` line 38; SRC`RELEASE_NOTES` lines 11-14

    The docs agree that `--no-autoupdate` "Doesn't apply on Windows, package-manager installs, or interactive terminal runs" because updates are already off there.
    https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/

5.4 **The non-TTY check also shows up in `RunFromTerminal`,** which is passed into the supervisor config. SRC`cmd/cloudflared/tunnel/configuration.go` lines 246, 296-298

5.5 **Root is not needed for `tunnel run`.**
    - The only `Geteuid()==0` check in the codebase is in the macOS *service install* path. SRC`cmd/cloudflared/macos_service.go` line 91
    - The tunnel makes only outbound connections: port **7844 TCP+UDP** to `region1/region2.v2.argotunnel.com`, plus optional 443 to `api.cloudflare.com`, `update.argotunnel.com` and `github.com` for updates.
    https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/

5.6 **ICMP proxy warnings on Linux are harmless for HTTP-only use.**
    - cloudflared opens unprivileged ICMP ("ping") sockets.
    - If the process GID is outside `/proc/sys/net/ipv4/ping_group_range` it warns: "The user running cloudflared process has a GID (group ID) that is not within ping_group_range... Otherwise cloudflared will not be able to ping this network".
    - It then logs "ICMP proxy feature is disabled" and **continues running**.
    - ICMP proxying only matters for WARP private-network routing, not for an HTTP public hostname.
    SRC`ingress/icmp_linux.go` lines 30, 57-61; SRC`cmd/cloudflared/tunnel/configuration.go` lines 260-265; issue example https://github.com/cloudflare/cloudflared/issues/1158

    **UNVERIFIED:** the exact developers.cloudflare.com page that documents the ping_group_range fix. The search surfaced a summary but no stable URL.

### 6. Embedding as a library

6.1 **No official statement found that cloudflared supports use as a Go library. Treat this as UNVERIFIED / unsupported.**
    - The README describes it only as a "command-line client" and daemon, and documents only CLI-level compatibility guarantees (1.6). SRC`README.md`
    - The module path is `github.com/cloudflare/cloudflared`, built with Go 1.27.4. SRC`go.mod`
    - The release tags are `YYYY.M.N` with no `v` prefix. Go modules only recognise `vMAJOR.MINOR.PATCH` tags as versions, so `go get` resolves to pseudo-versions and there is no semver API contract. https://go.dev/ref/mod#versions
    - The supported integration surface is therefore the CLI, its flags and env vars, and the metrics endpoints.

### 7. Remote visibility of connectors

7.1 **The API exposes per-connector details.** `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/connections` returns:
    - per connector: `id`, `arch` ("The cloudflared OS architecture used to establish this connection"), `version`, `run_at`, `config_version`, `features`
    - per connection (`conns[]`): `client_id` ("UUID of the Cloudflare Tunnel connector"), `client_version`, `colo_name`, `opened_at`, `origin_ip` ("The public IP address of the host running cloudflared")
    A per-connector endpoint `.../connectors/{connector_id}` also exists.
    https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/connections/methods/get/ ,
    https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/get

7.2 **The dashboard shows the same data.** Cloudflare's blog: expanding a tunnel shows its replicas' "connection status, data center, IP address, and version". The connector is labelled with the machine hostname plus connector ID unless `--label` is given (3, cmd.go:820-822).
    https://blog.cloudflare.com/observe-and-manage-cloudflare-tunnel/

    **UNVERIFIED:** the current dashboard layout. The blog post is older.

7.3 **Remote management can reach the connector.** It uses `management.argotunnel.com` (hidden flag `--management-hostname`). With `--management-diagnostics` (default **true**), a remote admin can pull /metrics and /debug/pprof through it. This is what powers dashboard log streaming and `cloudflared tail`.
    SRC`cmd/cloudflared/tunnel/cmd.go` lines 890-893, 1083-1087

    **Privacy-conscious deployments may want `--management-diagnostics=false`.** That is a judgment call, not Cloudflare guidance.

## Part B: data handling

### 8. Plaintext visibility and E2E options

8.1 **Cloudflare decrypts TLS at its edge.** The clearest official wording is in the Data Localization Suite docs:
    - TLS termination is "the point at which encrypted HTTPS traffic is decrypted".
    - "functions that require access to decrypted traffic are applied only at in-region Cloudflare locations".
    - For Enterprise products covered by Regional Services, Cloudflare "will only terminate TLS connections for these products in the geographic region you have configured".
    The product exists to control *where* Cloudflare decrypts, which presupposes that it does.
    https://developers.cloudflare.com/data-localization/regional-services/

8.2 **Edge certificates terminate the visitor's TLS at Cloudflare.** "Edge certificates are the SSL/TLS certificates that Cloudflare presents to visitors connecting to your domain... These certificates secure the encrypted connection between your visitors and Cloudflare."
    https://developers.cloudflare.com/ssl/edge-certificates/

    The SSL modes page describes "two connections": visitor to Cloudflare, and Cloudflare to origin.
    https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/

    "How Cloudflare works" describes the reverse proxy, which "can be configured to decrypt all incoming requests ... [and] cache content".
    https://developers.cloudflare.com/fundamentals/concepts/how-cloudflare-works/

8.3 **For a Tunnel public hostname (an HTTP service such as `http://127.0.0.1:3890`), the request is plaintext HTTP at Cloudflare.**
    - The visitor's TLS ends at the edge certificate (8.2).
    - The edge forwards the request over the cloudflared connection, which is TLS/QUIC to 7844.
    - cloudflared then makes a fresh local request to the origin. FAQ: "When using Cloudflare Tunnel, all requests to the origin are made internally between `cloudflared` and the origin."
    https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/

    **Explicit statement UNVERIFIED:** no single developers.cloudflare.com page says "Tunnel HTTP traffic is visible in plaintext to Cloudflare" in those words. It follows from 8.1 and 8.2, and from HTTP-layer features (WAF, Access, caching) being applied to Tunnel hostnames.

8.4 **The privacy policy describes Cloudflare's role, not its access.** It says "Cloudflare is a data processor for any of the content provided by Customers and End Users ... through the Services that transits, or in some cases, is stored on, the Cloudflare network" and "We are a conduit for information controlled by others." It does not state whether staff or systems inspect proxied content.
    https://www.cloudflare.com/privacypolicy/

8.5 **Keyless SSL does not give end-to-end encryption.** It keeps only the *private key* on customer infrastructure ("Keep private keys on your own infrastructure while using Cloudflare TLS"). The handshake still completes at Cloudflare, which derives the session keys. The technical blog explains that the key server only performs the private-key operation.
    https://developers.cloudflare.com/ssl/keyless-ssl/ ,
    https://blog.cloudflare.com/keyless-ssl-the-nitty-gritty-technical-details/
    (Cloudflare's learning page returned 403 to the fetcher.)

8.6 **E2E-ish options. Each needs the application to carry its own TLS, so Cloudflare relays ciphertext at Layer 4:**
    - **Arbitrary TCP via Tunnel plus `cloudflared access tcp` on the client.** The tunnel publishes a `tcp://` service, and the client runs `cloudflared access tcp --hostname ... --url localhost:PORT`. Cloudflare proxies the TCP bytes. If the origin itself speaks TLS (for example, the app serves HTTPS with its own cert), Cloudflare sees only the outer stream. Cost: every client must install cloudflared.
      https://developers.cloudflare.com/access/other-protocols/tcp-guide , SRC`README.md` ("access Tunnel origins ... for TCP traffic at Layer 4")
    - **WARP client plus Tunnel private-network routing.** The client reaches the origin's private IP at L4. **Gateway TLS decryption is a separate setting.** Docs: when it is off, "information contained within HTTPS encryption, such as the full URL, headers, and request body, will not be visible to Gateway". When it is on, "Gateway ... terminates the connection from the client and creates a new connection to the origin server". With decryption off and app-level TLS, the payload stays opaque to Cloudflare.
      https://developers.cloudflare.com/cloudflare-one/traffic-policies/http-policies/tls-decryption/
    - **Application-layer E2E** (payload encryption inside HTTP) works over any of these. It is not a Cloudflare feature.

    **UNVERIFIED:** whether Gateway TLS decryption is off by default. The page describes it as a setting you turn on but does not state the default.

## Implications for a supervisor (synthesis, not sourced claims)

- Pin and verify the binary: parse the SHA-256 checksums from the release body.
- Run `cloudflared tunnel run --no-autoupdate --metrics 127.0.0.1:<port> --output json --grace-period 5s`.
- Pass the token through the `TUNNEL_TOKEN` env var or `--token-file` (0600). Never put it on argv.
- Poll `/ready` for `readyConnections > 0`. Treat exit 11 or 10 as "something self-updated" (it should not happen with `--no-autoupdate`).
- Stop with SIGTERM, then SIGKILL after the grace period.
- Tell users plainly that a remotely managed HTTP tunnel gives Cloudflare plaintext access to every request and response, including any auth headers and cookies yaran uses.
