#!/bin/sh
# Container entrypoint: seed an isolated yaran config + a couple of demo repos on
# first run, then serve the web UI. All state lives under /data and /repos
# (named volumes), so nothing here touches the host's real ~/.config/yaran.
set -e

export YARAN_HOME=/data/yaran
PORT="${YARAN_PORT:-8790}"

# --- Seed a valid config on first boot -------------------------------------
# `yaran config regenerate --yes` writes the full canonical default config (all
# four default providers) headlessly. We then append a fake streaming provider
# used to exercise the working-state visuals. Idempotent: only on first boot.
if [ ! -f "$YARAN_HOME/config.toml" ]; then
  echo "entrypoint: generating fresh yaran config at $YARAN_HOME"
  yaran config regenerate --yes
  cat >> "$YARAN_HOME/config.toml" <<'EOF'

[providers.fake]
command = "/usr/local/bin/fake-agent"
args = []
EOF
fi

# --- Seed demo git repos (so the project picker has something to add) -------
git config --global init.defaultBranch main
git config --global user.email "yaran@example.com"
git config --global user.name "yaran preview"
git config --global --add safe.directory '*'
# Nothing in here can answer a credential prompt, and the container has a tty, so
# a git operation against an unreachable remote would sit on "Username for ..."
# forever and wedge whatever yaran was doing. Fail fast instead.
git config --global credential.helper ""
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/bin/true

for r in demo-api demo-web; do
  d="/repos/$r"
  if [ ! -d "$d/.git" ]; then
    echo "entrypoint: seeding repo $d"
    mkdir -p "$d/src"
    (
      cd "$d"
      git init -q
      printf '# %s\n\nSeed repo for yaran preview.\n' "$r" > README.md
      printf 'def main():\n    print("hello from %s")\n' "$r" > src/main.py
      git add -A
      git commit -qm "Seed $r"
    )
  fi
done

# --- Screenshot fixtures (opt-in) ------------------------------------------
# The committed screenshot tool needs two stand-ins an ordinary preview must not
# have: a `gh` answering only yaran's auth probe, its bounded `pr view` and the
# pull-request sync's GraphQL questions from a canned table, so the pull-request
# chip, banner, list and dialogs can be shot without a GitHub login, and a transcript provider standing in for `claude`, so the standalone
# agent shows a scripted session rather than a streaming fixture. Both are
# mounted read-only and installed only when this is asked for, and the marker
# file is how the host tells a screens container from a plain one.
if [ "${YARAN_SCREENS:-0}" = "1" ] && [ -d /fixtures ]; then
  echo "entrypoint: installing screenshot fixtures (stand-in gh, transcript provider)"
  # The scenes seed several agents per project and write into their worktrees.
  # Keep that fixture independent of the ordinary first-run workspace default.
  sed -i 's/^default_mode = "shared"$/default_mode = "worktree"/' "$YARAN_HOME/config.toml"
  install -m 0755 /fixtures/gh /usr/local/bin/gh
  install -m 0755 /fixtures/notes-agent /usr/local/bin/claude
  # The tab strip shows one tab per provider, and yaran refuses to open a tab for a
  # CLI that is not on PATH. opencode is not installed here, so it points at the
  # fake provider: that shot is about the strip, not about opencode.
  ln -sf /usr/local/bin/fake-agent /usr/local/bin/opencode
  : > /data/screens-mode
else
  rm -f /data/screens-mode
fi

# --- Journey seed hooks (opt-in) -------------------------------------------
# The container journey suite (crates/yaran-journeys) copies shell hooks into
# /journey/seed.d before the container starts, to shape the config a journey
# needs (a port, a setting, a password set through `yaran config set`). They run
# on every start, after the config above exists and before yaran does, in name
# order; a hook that fails stops the container, loudly.
if [ -d /journey/seed.d ]; then
  for hook in /journey/seed.d/*.sh; do
    [ -f "$hook" ] || continue
    echo "entrypoint: running seed hook $hook"
    sh "$hook"
  done
fi

# --- A stand-in Tailscale (opt-in) -----------------------------------------
# YARAN_FAKE_TAILSCALE=1 puts tailscale-stand-in on PATH, answering from files
# under /data/tailscale that a journey may rewrite while yaran runs, and gives
# loopback the address it reports so the Tailscale listener really binds. That
# second step needs the NET_ADMIN capability, inside this container's own
# network namespace; without it the start fails rather than serving a tailnet
# leg that cannot exist. Every name and address is obviously fake.
if [ "${YARAN_FAKE_TAILSCALE:-0}" = "1" ]; then
  ts=/data/tailscale
  mkdir -p "$ts"
  [ -f "$ts/ip" ] || echo "100.101.102.103" > "$ts/ip"
  ts_ip="$(cat "$ts/ip")"
  if [ ! -f "$ts/status.json" ]; then
    cat > "$ts/status.json" <<EOF
{"BackendState":"Running","TailscaleIPs":["$ts_ip"],"Self":{"HostName":"journey-box","DNSName":"journey-box.example-tailnet.ts.net.","TailscaleIPs":["$ts_ip"],"Online":true},"MagicDNSSuffix":"example-tailnet.ts.net","CurrentTailnet":{"Name":"example-tailnet","MagicDNSSuffix":"example-tailnet.ts.net","MagicDNSEnabled":true},"CertDomains":["journey-box.example-tailnet.ts.net"]}
EOF
  fi
  [ -f "$ts/serve.json" ] || echo "{}" > "$ts/serve.json"
  install -m 0755 /usr/local/share/yaran-preview/tailscale-stand-in /usr/local/bin/tailscale
  ip addr show dev lo | grep -q "inet $ts_ip/" || ip addr add "$ts_ip/32" dev lo
  # A second tailnet address for the stand-in PEER, so a relayed tailnet
  # connection comes from somebody other than yaran itself. It is a local ROUTE,
  # not an address on an interface: the relay can still connect from it, but
  # it is not one of this machine's own addresses, which yaran reads from the
  # interfaces and counts as the network, the way a real tailnet peer is not.
  peer_ip="${YARAN_TAILNET_PEER_IP:-100.101.102.104}"
  ip route show table local | grep -q "^local $peer_ip " ||
    ip route add local "$peer_ip/32" dev lo
  echo "entrypoint: stand-in tailscale answering with $ts_ip (peer $peer_ip)"
  YARAN_NO_TAILSCALE=0
fi

# YARAN_TAIL_LOG=1 copies yaran.log onto the container's own output, so a journey
# that fails prints what yaran logged, and a journey can wait for a log line.
if [ "${YARAN_TAIL_LOG:-0}" = "1" ]; then
  touch "$YARAN_HOME/yaran.log"
  tail -n +1 -F "$YARAN_HOME/yaran.log" 2> /dev/null | sed -u 's/^/yaran.log: /' &
fi

# --- Port relays (opt-in) ---------------------------------------------------
# YARAN_RELAYS="4100=100.101.102.103:3890 4200=127.0.0.1:3890" listens on each
# published port and relays the raw TCP stream to the address after `=`, from
# inside this container. A relay onto loopback is a headerless forward (what
# `tailscale serve` with a TCP forward, or any port forwarder, looks like to
# yaran); a relay onto the stand-in Tailscale address arrives on the Tailscale
# listener the way a tailnet peer's connection does.
for relay in ${YARAN_RELAYS:-}; do
  listen="${relay%%=*}"
  target="${relay#*=}"
  echo "entrypoint: relaying port $listen to $target"
  socat "TCP-LISTEN:$listen,fork,reuseaddr" "TCP:$target" &
done

# The Tailscale flag is a variable because the Preferences screenshot needs it
# gone: `--no-tailscale` refuses a live mode change for the whole run, and the
# dialog says so instead of carrying the general copy the docs describe.
if [ "${YARAN_NO_TAILSCALE:-1}" = "1" ]; then
  set -- --no-tailscale
else
  set --
fi

# Where yaran listens. The preview binds every interface, which is what makes it
# reachable through the published port. YARAN_BIND=local serves the way an
# unconfigured yaran does instead (loopback, plus the Tailscale leg when there is
# one) on $PORT, so a journey can tell this machine and a tailnet peer apart.
if [ "${YARAN_BIND:-}" = "local" ]; then
  set -- --port "$PORT" "$@"
  where="loopback (and Tailscale, if any) port $PORT"
else
  set -- --bind "${YARAN_BIND:-0.0.0.0:$PORT}" "$@"
  where="${YARAN_BIND:-0.0.0.0:$PORT}"
fi

# YARAN_LAUNCH=tui runs the terminal UI in a detached tmux session instead of
# `yaran server`, for the journeys that serve from the TUI (the flip, or
# `[server] serve_while_tui`); the container lives as long as that session does,
# and a journey drives it with `tmux -L journey send-keys`.
if [ "${YARAN_LAUNCH:-server}" = "tui" ]; then
  echo "entrypoint: running the yaran terminal UI in tmux session 'journey'"
  tmux -L journey new-session -d -s journey -x 160 -y 45 \
    -e "YARAN_HOME=$YARAN_HOME" -e TERM=xterm-256color yaran
  while tmux -L journey has-session -t journey 2> /dev/null; do sleep 1; done
  echo "entrypoint: the yaran terminal UI exited"
  exit 0
fi

# YARAN_RESTART_LOOP=1 starts yaran again whenever it exits, so a journey can stop
# the process inside this container and see a NEW run come up behind the same
# published port and the same state, the way a quick restart looks to an open tab.
# While /tmp/yaran-hold exists the loop waits before starting the next run, so a
# journey can keep yaran down for as long as it needs.
if [ "${YARAN_RESTART_LOOP:-0}" = "1" ]; then
  while :; do
    echo "entrypoint: serving yaran web UI on $where (restart loop)"
    yaran server "$@" || true
    sleep 0.2
    while [ -f /tmp/yaran-hold ]; do sleep 0.2; done
  done
fi

echo "entrypoint: serving yaran web UI on $where (isolated)"
exec yaran server "$@"
