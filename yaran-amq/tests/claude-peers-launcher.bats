#!/usr/bin/env bats
#
# claude-peers-launcher is the CLAUDE_CODE_PROCESS_WRAPPER claude-amq sets.
# Claude Code runs its self-relaunch through it as `<launcher> <claude>
# <args...>`; observed live (2.1.318), `/restart` passes
# `claude --resume <id> --effort low --permission-mode auto ...` with no
# --dangerously-load-development-channels, which silently turned claude-peers
# off in every lane that was restarted.

load 'lib/setup'

LAUNCHER="$BATS_TEST_DIRNAME/../wrappers/claude-peers-launcher"
PEERS_FLAG="--dangerously-load-development-channels"

setup() {
  setup_isolated_home
  unset CLAUDE_PEERS_DISABLE
  mkdir -p "$TEST_HOME/bin"
  ARGV_FILE="$TEST_HOME/argv.log"
  # Stands in for the claude binary Claude Code hands the launcher.
  cat >"$TEST_HOME/bin/claude-bin" <<'SH'
#!/bin/sh
for arg in "$@"; do printf '%s\n' "$arg"; done >"$ARGV_FILE"
printf 'WRAPPER=%s\n' "${CLAUDE_CODE_PROCESS_WRAPPER-}" >>"$ARGV_FILE"
SH
  chmod +x "$TEST_HOME/bin/claude-bin"
  printf '#!/bin/sh\necho /dev/ttys-pane\n' >"$TEST_HOME/bin/tty"
  chmod +x "$TEST_HOME/bin/tty"
  export PATH="$TEST_HOME/bin:$PATH" ARGV_FILE
  export YARAN_CLAUDE_PEERS_TTY=/dev/ttys-pane
  export CLAUDE_CODE_PROCESS_WRAPPER="$LAUNCHER"
}

teardown() {
  teardown_isolated_home
}

relaunch() {
  run "$LAUNCHER" "$TEST_HOME/bin/claude-bin" "$@"
  [ "$status" -eq 0 ]
}

flag_count() {
  grep -Fxc -- "$PEERS_FLAG" "$ARGV_FILE" || true
}

@test "the pane's own relaunch gets the channel back, appended last" {
  relaunch --resume abc --effort low --permission-mode auto
  [ "$(flag_count)" -eq 1 ]
  [ "$(sed -n 7p "$ARGV_FILE")" = "$PEERS_FLAG" ]
  [ "$(sed -n 8p "$ARGV_FILE")" = "server:claude-peers" ]
  [ "$(sed -n 1p "$ARGV_FILE")" = "--resume" ]
}

@test "the environment passes through, so the next restart is wrapped too" {
  relaunch --resume abc
  grep -Fxq "WRAPPER=$LAUNCHER" "$ARGV_FILE"
}

@test "a process on another terminal (daemon-hosted session) runs as asked" {
  export YARAN_CLAUDE_PEERS_TTY=/dev/ttys-elsewhere
  relaunch --session-id 11111111-2222-4333-8444-555555555555 --fork-session
  [ "$(flag_count)" -eq 0 ]
}

@test "subcommands, print mode and -- run as asked" {
  relaunch bg-pty-host --bg-pty-host /tmp/x.sock 200 50 -- /x/claude --session-id s
  [ "$(flag_count)" -eq 0 ]
  relaunch daemon
  [ "$(flag_count)" -eq 0 ]
  relaunch -p "hello"
  [ "$(flag_count)" -eq 0 ]
  relaunch --resume abc -- extra
  [ "$(flag_count)" -eq 0 ]
}

@test "a relaunch that still has the flag is not given a second one" {
  relaunch --resume abc "$PEERS_FLAG" server:claude-peers
  [ "$(flag_count)" -eq 1 ]
  relaunch --resume abc "$PEERS_FLAG=server:claude-peers"
  [ "$(flag_count)" -eq 0 ]
}

@test "CLAUDE_PEERS_DISABLE=1 or no recorded pane terminal leaves argv alone" {
  CLAUDE_PEERS_DISABLE=1 relaunch --resume abc
  [ "$(flag_count)" -eq 0 ]
  unset YARAN_CLAUDE_PEERS_TTY
  relaunch --resume abc
  [ "$(flag_count)" -eq 0 ]
}

@test "with nothing to run the launcher refuses" {
  run "$LAUNCHER"
  [ "$status" -eq 64 ]
  [[ "$output" == *"no command to run"* ]]
}
