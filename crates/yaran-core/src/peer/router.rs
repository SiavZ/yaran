//! `yaran peer`: route a message between Yaran agent sessions over the right
//! transport, so agents never pick between AMQ and Claude Peers themselves.
//!
//! Transport rules (the fork's, unchanged):
//!
//! - Claude-to-Claude routes always use Claude Peers, including sessions in a
//!   shared workspace. An explicit `--transport amq` is refused for that pair.
//! - Either endpoint in a shared workspace for other provider combinations,
//!   unless the target is jcode: always AMQ. Claude Peers keys a registration
//!   by working directory, so it cannot tell mixed-provider agents apart.
//! - Otherwise `auto` sends to a Claude or jcode target over Claude Peers
//!   (the broker is then required, not a best-effort preference) and to
//!   anything else over AMQ. `--transport amq` is the manual override.
//! - A jcode target's registration is the claude-peers server its jcode
//!   session runs (`JCODE_MCP_CHANNEL_SESSION` in its environment), found by
//!   directory, shared workspace or not. Older jcode shared one server across
//!   sessions and dropped every push, so a registration without that marker
//!   is never used, and two marked ones in one directory get AMQ, not a guess.
//! - When a Claude target cannot take a Claude Peers push right now (the
//!   broker is not answering, the target has no registration because its
//!   claude-peers server died, or its Claude Code no longer loads the channel
//!   and would discard the push), `auto` delivers over AMQ instead and says
//!   why; an explicit `--transport claude-peers` is refused with the reason.
//! - A Claude target's registration is the one whose process names the agent
//!   (`YARAN_SESSION_ID`), wherever its working directory is; the directory
//!   is only the fallback for registrations that name no agent.
//!
//! Only live sessions whose directory still exists are listed or routable.

use std::collections::HashSet;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, anyhow, bail};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use super::PeerSession;
use super::amq::{AmqSyncReport, require_amq_root, sync_amq_agents};
use super::broker::{ClaudePeer, claude_peers_list, claude_peers_send};
use super::handle::{amq_handle, utf8_lossy};
use crate::config::YaranPaths;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TransportPreference {
    Auto,
    Amq,
    ClaudePeers,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChosenTransport {
    Amq,
    ClaudePeers,
}

#[derive(Clone, Debug)]
struct PeerTarget {
    handle: String,
    session: Option<PeerSession>,
}

#[derive(Clone, Debug)]
struct SenderContext {
    handle: String,
    session: Option<PeerSession>,
}

pub(crate) const PEER_HELP: &str = "\
yaran peer - route messages between Yaran agent sessions

Subcommands:
  yaran peer send [--from <handle>] [--transport auto|amq|claude-peers] <target> <message...>
                       Send through the Yaran router. Claude-to-Claude routes
                       always use Claude Peers, as do routes to jcode agents;
                       other shared routes use AMQ.
  yaran peer list        List Yaran sessions and transport health.
  yaran peer sync-amq    Reconcile AMQ's agent registry from sessions.sqlite3.

Agents should use this command instead of calling amq or Claude Peers directly.";

/// What a running yaran answers `yaran peer` with: the AMQ registry pass it
/// just ran and the sessions a message can reach.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PeerSnapshot {
    /// What reconciling the shared AMQ registry changed.
    pub report: AmqSyncReport,
    /// The live sessions a message can reach.
    pub sessions: Vec<PeerSession>,
}

/// Reconcile the AMQ registry from this store and list the routable sessions.
/// Only the process holding `dux.lock` runs this: the command line asks a
/// running yaran for the answer instead of opening the database itself.
///
/// # Errors
///
/// Fails when the registry or the session database cannot be read.
pub fn sync_and_list(paths: &YaranPaths) -> Result<PeerSnapshot> {
    let report = sync_amq_agents(paths)?;
    let sessions = load_sessions_if_present(paths)?;
    Ok(PeerSnapshot { report, sessions })
}

/// Entry point for `yaran peer <args>`. `fetch` asks the running yaran for a
/// [`PeerSnapshot`]; the command line never opens the session database.
///
/// # Errors
///
/// Fails on an unknown subcommand or flag, when the running yaran cannot be
/// asked, or when the message cannot be delivered.
pub fn run_peer(
    args: &[String],
    paths: &YaranPaths,
    fetch: &dyn Fn() -> Result<PeerSnapshot>,
    out: &mut dyn Write,
) -> Result<()> {
    let sub = args.first().map_or("", String::as_str);
    match sub {
        "send" => run_peer_send(&args[1..], paths, fetch, out),
        "list" => run_peer_list(&args[1..], paths, fetch, out),
        "sync-amq" | "sync" => run_peer_sync_amq(&args[1..], fetch, out),
        "" | "--help" | "-h" => {
            writeln!(out, "{PEER_HELP}")?;
            Ok(())
        }
        other => bail!("unknown peer subcommand: {other}\nRun `yaran peer --help` for usage."),
    }
}

fn run_peer_send(
    args: &[String],
    paths: &YaranPaths,
    fetch: &dyn Fn() -> Result<PeerSnapshot>,
    out: &mut dyn Write,
) -> Result<()> {
    let Some(parsed) = parse_send_args(args)? else {
        writeln!(out, "{PEER_HELP}")?;
        return Ok(());
    };
    let PeerSnapshot { sessions, .. } = fetch()?;

    let sender = infer_sender(parsed.from.as_deref(), &sessions)?;
    let target = resolve_target(&parsed.target, &sessions)?;
    let transport = choose_transport(parsed.transport, &sender, &target)?;

    match transport {
        ChosenTransport::ClaudePeers => {
            let target_session = target
                .session
                .as_ref()
                .ok_or_else(|| anyhow!("Claude Peers requires a known Claude target session"))?;
            let route = match claude_peers_list() {
                Err(_) => Err(PeersUnavailable::Broker),
                Ok(peers) => {
                    let processes = ProcessTable::snapshot(yaran_tui_pid(paths));
                    match reachable_claude_peer(target_session, &peers, &processes) {
                        Ok(to_id) => Ok((peers, processes, to_id)),
                        Err(unreachable) => Err(PeersUnavailable::Target(unreachable)),
                    }
                }
            };
            match route {
                Ok((peers, processes, to_id)) => {
                    let (from_id, message) =
                        claude_peers_sender(&sender, &peers, &parsed.message, &processes);
                    claude_peers_send(&from_id, &to_id, &message)?;
                    writeln!(
                        out,
                        "sent via claude-peers: {} -> {}",
                        sender.handle, target.handle
                    )?;
                }
                Err(why) => {
                    let reason = amq_fallback_reason(parsed.transport, &why, &target.handle)?;
                    let root = require_amq_root(paths)?;
                    amq_send(&root, &sender.handle, &target.handle, &parsed.message)?;
                    writeln!(
                        out,
                        "sent via amq: {} -> {} ({reason})",
                        sender.handle, target.handle
                    )?;
                }
            }
        }
        ChosenTransport::Amq => {
            let root = require_amq_root(paths)?;
            amq_send(&root, &sender.handle, &target.handle, &parsed.message)?;
            writeln!(out, "sent via amq: {} -> {}", sender.handle, target.handle)?;
        }
    }

    Ok(())
}

fn run_peer_list(
    args: &[String],
    paths: &YaranPaths,
    fetch: &dyn Fn() -> Result<PeerSnapshot>,
    out: &mut dyn Write,
) -> Result<()> {
    reject_unknown_peer_flags(args)?;
    let PeerSnapshot { report, sessions } = fetch()?;

    let peers = claude_peers_list().ok();
    let processes = peers
        .as_ref()
        .map(|_| ProcessTable::snapshot(yaran_tui_pid(paths)));
    writeln!(out, "Yaran peers:")?;
    if sessions.is_empty() {
        writeln!(out, "  (no persisted sessions)")?;
    } else {
        for session in &sessions {
            let note = match (&peers, &processes) {
                (Some(peers), Some(processes)) if session.takes_claude_peers() => {
                    match reachable_claude_peer(session, peers, processes) {
                        Ok(_) => "",
                        Err(Unreachable::Unregistered) => {
                            "  [not registered with Claude Peers: messages go via AMQ until its claude-peers server is reconnected]"
                        }
                        Err(Unreachable::ChannelOff) => {
                            "  [claude-peers channel off: messages go via AMQ until restarted]"
                        }
                        Err(Unreachable::Ambiguous) => {
                            "  [another jcode session shares this directory: messages go via AMQ]"
                        }
                    }
                }
                _ => "",
            };
            writeln!(
                out,
                "  {:<32} {:<8} {}{note}",
                session.agent_handle(),
                session.provider,
                session.directory
            )?;
        }
    }

    if report.skipped {
        writeln!(out, "AMQ registry: skipped (no configured AMQ root found)")?;
    } else if let Some(root) = report.root {
        writeln!(
            out,
            "AMQ registry: {} (added {}, removed stale {}, deconflicted {})",
            root.display(),
            report.configured_agents_added,
            report.stale_config_agents_removed,
            report.handles_deconflicted
        )?;
    }

    match &peers {
        Some(peers) => writeln!(
            out,
            "Claude Peers broker: {} peer(s) registered",
            peers.len()
        )?,
        None => writeln!(
            out,
            "Claude Peers broker: unavailable (messages to Claude agents go via AMQ)"
        )?,
    }

    Ok(())
}

fn run_peer_sync_amq(
    args: &[String],
    fetch: &dyn Fn() -> Result<PeerSnapshot>,
    out: &mut dyn Write,
) -> Result<()> {
    reject_unknown_peer_flags(args)?;
    let PeerSnapshot { report, .. } = fetch()?;
    let Some(root) = report.root.as_ref().filter(|_| !report.skipped) else {
        writeln!(out, "AMQ sync skipped: no configured AMQ root found")?;
        return Ok(());
    };
    writeln!(out, "AMQ sync: {}", root.display())?;
    writeln!(
        out,
        "  configured agents added: {}",
        report.configured_agents_added
    )?;
    writeln!(
        out,
        "  stale config agents removed: {}",
        report.stale_config_agents_removed
    )?;
    writeln!(
        out,
        "  ownership markers created: {}",
        report.ownership_markers_created
    )?;
    writeln!(
        out,
        "  handles deconflicted: {}",
        report.handles_deconflicted
    )?;
    Ok(())
}

#[derive(Debug)]
struct SendArgs {
    from: Option<String>,
    transport: TransportPreference,
    target: String,
    message: String,
}

/// Parse `yaran peer send` arguments. `Ok(None)` means help was requested.
/// Flags are only recognised before the target: everything after it is the
/// message, so message words that look like flags are sent verbatim.
fn parse_send_args(args: &[String]) -> Result<Option<SendArgs>> {
    let mut from = None;
    let mut transport = TransportPreference::Auto;
    let mut positional = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if !positional.is_empty() {
            positional.extend(args[i..].iter().cloned());
            break;
        }
        match args[i].as_str() {
            "--from" => {
                i += 1;
                let Some(value) = args.get(i) else {
                    bail!("--from requires a value");
                };
                from = Some(value.clone());
            }
            "--transport" => {
                i += 1;
                let Some(value) = args.get(i) else {
                    bail!("--transport requires auto, amq, or claude-peers");
                };
                transport = match value.as_str() {
                    "auto" => TransportPreference::Auto,
                    "amq" => TransportPreference::Amq,
                    "claude-peers" => TransportPreference::ClaudePeers,
                    other => bail!("unknown transport: {other}"),
                };
            }
            "--" => {
                positional.extend(args[i + 1..].iter().cloned());
                break;
            }
            "-h" | "--help" => return Ok(None),
            arg if arg.starts_with('-') => bail!("unknown flag: {arg}"),
            _ => positional.push(args[i].clone()),
        }
        i += 1;
    }

    if positional.len() < 2 {
        bail!("usage: yaran peer send <target> <message...>");
    }
    Ok(Some(SendArgs {
        from,
        transport,
        target: positional[0].clone(),
        message: positional[1..].join(" "),
    }))
}

fn reject_unknown_peer_flags(args: &[String]) -> Result<()> {
    for arg in args {
        if arg.starts_with('-') {
            bail!("unknown flag: {arg}");
        }
    }
    Ok(())
}

/// The live sessions a message can reach, read from this store. Only the
/// process holding `dux.lock` calls it.
///
/// # Errors
///
/// Fails when the session database cannot be read.
pub fn routable_sessions(paths: &YaranPaths) -> Result<Vec<PeerSession>> {
    load_sessions_if_present(paths)
}

fn load_sessions_if_present(paths: &YaranPaths) -> Result<Vec<PeerSession>> {
    if !paths.sessions_db_path.exists() {
        return Ok(Vec::new());
    }
    let sessions = super::session_store::open(paths)?
        .load_sessions()
        .context("failed to load Yaran sessions")?;
    Ok(sessions
        .into_iter()
        .filter(PeerSession::is_routable)
        .collect())
}

fn infer_sender(from: Option<&str>, sessions: &[PeerSession]) -> Result<SenderContext> {
    if let Some(from) = from {
        let handle = amq_handle(from);
        if handle.is_empty() {
            bail!("--from normalizes to an empty AMQ handle");
        }
        // An exact handle beats any alias, so another session whose branch
        // happens to equal this handle cannot impersonate it.
        if let Some(session) = sessions
            .iter()
            .find(|session| session.agent_handle() == handle)
            .cloned()
        {
            return Ok(SenderContext {
                handle,
                session: Some(session),
            });
        }
        let session = sessions
            .iter()
            .find(|session| {
                let aliases = session_aliases(session);
                aliases.contains(from) || aliases.contains(&handle)
            })
            .cloned();
        return Ok(SenderContext { handle, session });
    }

    if let Ok(id) = crate::brand_env::var("YARAN_SESSION_ID")
        && let Some(session) = sessions.iter().find(|session| session.id == id)
    {
        return Ok(SenderContext {
            handle: session.agent_handle().to_string(),
            session: Some(session.clone()),
        });
    }

    for var in ["YARAN_AMQ_HANDLE", "AM_ME"] {
        if let Ok(value) = crate::brand_env::var(var) {
            let handle = amq_handle(&value);
            if !handle.is_empty() {
                let session = sessions
                    .iter()
                    .find(|session| session.agent_handle() == handle)
                    .cloned();
                return Ok(SenderContext { handle, session });
            }
        }
    }

    if let Ok(cwd) = env::current_dir()
        && let Some(session) = session_for_cwd(&cwd, sessions)?
    {
        return Ok(SenderContext {
            handle: session.agent_handle().to_string(),
            session: Some(session.clone()),
        });
    }

    Ok(SenderContext {
        handle: "yaran-router".to_string(),
        session: None,
    })
}

fn resolve_target(target: &str, sessions: &[PeerSession]) -> Result<PeerTarget> {
    let sanitized = amq_handle(target);
    let mut matches = Vec::new();
    for session in sessions {
        let aliases = session_aliases(session);
        if aliases.contains(target) || (!sanitized.is_empty() && aliases.contains(&sanitized)) {
            matches.push(session.clone());
        }
    }

    if matches.len() > 1 {
        let names = matches
            .iter()
            .map(|session| format!("{} ({})", session.agent_handle(), session.id))
            .collect::<Vec<_>>()
            .join(", ");
        bail!("ambiguous peer target {target:?}; matches: {names}");
    }

    if let Some(session) = matches.pop() {
        return Ok(PeerTarget {
            handle: session.agent_handle().to_string(),
            session: Some(session),
        });
    }

    if sanitized.is_empty() {
        bail!("target normalizes to an empty AMQ handle");
    }
    bail!(
        "agent {target:?} does not exist or is not reachable; run `yaran peer list` and retry with a listed handle"
    )
}

fn choose_transport(
    preference: TransportPreference,
    sender: &SenderContext,
    target: &PeerTarget,
) -> Result<ChosenTransport> {
    let claude_to_claude =
        is_claude_session(sender.session.as_ref()) && is_claude_session(target.session.as_ref());
    if claude_to_claude {
        if preference == TransportPreference::Amq {
            bail!(
                "AMQ cannot route Claude-to-Claude sessions; use --transport claude-peers or omit --transport"
            );
        }
        return Ok(ChosenTransport::ClaudePeers);
    }

    let shared_endpoint = sender
        .session
        .as_ref()
        .is_some_and(|session| session.shared_workspace)
        || target
            .session
            .as_ref()
            .is_some_and(|session| session.shared_workspace);
    // A jcode target's registration is told apart by jcode's own marker, not
    // by directory alone, so a shared workspace does not rule it out.
    let jcode_target = target
        .session
        .as_ref()
        .is_some_and(|s| s.provider == "jcode");
    if shared_endpoint && !jcode_target {
        if preference == TransportPreference::ClaudePeers {
            bail!(
                "Claude Peers cannot route shared-workspace sessions; use --transport amq or omit --transport"
            );
        }
        return Ok(ChosenTransport::Amq);
    }

    match preference {
        TransportPreference::Amq => Ok(ChosenTransport::Amq),
        TransportPreference::ClaudePeers => {
            ensure_claude_peers_target(target)?;
            Ok(ChosenTransport::ClaudePeers)
        }
        TransportPreference::Auto => {
            if takes_claude_peers(target.session.as_ref()) {
                Ok(ChosenTransport::ClaudePeers)
            } else {
                Ok(ChosenTransport::Amq)
            }
        }
    }
}

fn ensure_claude_peers_target(target: &PeerTarget) -> Result<()> {
    if !takes_claude_peers(target.session.as_ref()) {
        let provider = target
            .session
            .as_ref()
            .map_or("unknown", |s| s.provider.as_str());
        bail!("Claude Peers transport cannot target provider {provider}; use AMQ");
    }
    Ok(())
}

fn is_claude_session(session: Option<&PeerSession>) -> bool {
    session.is_some_and(PeerSession::is_claude)
}

fn takes_claude_peers(session: Option<&PeerSession>) -> bool {
    session.is_some_and(PeerSession::takes_claude_peers)
}

fn amq_send(root: &Path, from: &str, target: &str, message: &str) -> Result<()> {
    let output = Command::new("amq")
        .arg("send")
        .arg("--to")
        .arg(target)
        .arg("--body")
        .arg(message)
        .env("AM_ROOT", root)
        .env("AM_ME", from)
        .output()
        .context("failed to execute amq")?;
    if !output.status.success() {
        bail!("amq send failed: {}", utf8_lossy(&output.stderr));
    }
    Ok(())
}

/// Who a Claude Peers message comes from. A Claude sender registered with the
/// broker sends as itself; anyone else sends under its Yaran handle with a
/// preamble telling the recipient to reply through `yaran peer send`, because
/// the broker cannot deliver back to a non-peer.
fn claude_peers_sender(
    sender: &SenderContext,
    peers: &[ClaudePeer],
    message: &str,
    processes: &ProcessTable,
) -> (String, String) {
    // A sender whose channel is off would never see the reply pushed back.
    if let Some(session) = sender.session.as_ref()
        && session.takes_claude_peers()
        && let Ok(id) = reachable_claude_peer(session, peers, processes)
    {
        return (id, message.to_string());
    }

    let body = format!(
        "YARAN peer {handle} sent this via Claude Peers.\n\
         Reply with `yaran peer send {handle} \"...\"`; this sender is not a Claude Peers peer.\n\n\
         {message}",
        handle = sender.handle,
        message = message,
    );
    (sender.handle.clone(), body)
}

/// Depth cap when walking a process's ancestry. Panes and daemon hosts sit a
/// handful of levels below their owner; the cap only stops a walk that a
/// pid-reuse cycle would otherwise make unbounded.
const MAX_ANCESTRY_DEPTH: usize = 32;

/// What kind of process owns a Claude Peers registration, ranked by how
/// likely it is to be the conversation a human or agent is actually driving.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum PeerHost {
    /// A Claude Code daemon `bg-spare`: pre-warmed, nobody reads it.
    Spare,
    /// Anything unrecognised, such as a plain `claude` in a terminal.
    Client,
    /// The process yaran spawned in the pane.
    Pane,
    /// A daemon-hosted session (`claude bg-pty-host ... --session-id`): once
    /// Claude Code continues or forks a pane's conversation, this is where
    /// the turns happen while the pane's original process lingers.
    DaemonSession,
}

/// Why a Claude session cannot take a Claude Peers push right now.
#[derive(Debug, PartialEq, Eq)]
enum Unreachable {
    Unregistered,
    /// Registered, but its Claude Code did not load the channel: the MCP
    /// server drains the broker queue and Claude Code discards each push.
    ChannelOff,
    /// A jcode agent whose directory holds more than one jcode session's
    /// registration: nothing says which is the agent's.
    Ambiguous,
}

/// Why a Claude target cannot take a Claude Peers push right now.
#[derive(Debug, PartialEq, Eq)]
enum PeersUnavailable {
    /// The broker is not answering at all.
    Broker,
    Target(Unreachable),
}

impl PeersUnavailable {
    /// What is wrong and how to get Claude Peers back, for the send output.
    fn reason(&self, target: &str) -> String {
        match self {
            Self::Broker => {
                "the Claude Peers broker is not answering; the next Claude agent yaran \
                             starts brings it back"
                    .to_string()
            }
            Self::Target(Unreachable::Unregistered) => format!(
                "{target} has no Claude Peers registration because its claude-peers server is not \
                 running; reconnect claude-peers with /mcp in that agent, or restart it in yaran"
            ),
            Self::Target(Unreachable::ChannelOff) => format!(
                "{target} is not listening on the claude-peers channel because Claude Code \
                 relaunched itself without it; restart the agent in yaran to restore Claude Peers"
            ),
            Self::Target(Unreachable::Ambiguous) => format!(
                "{target} shares its directory with another jcode session, so its Claude Peers \
                 registration cannot be told apart from that one's"
            ),
        }
    }
}

/// A Claude target that cannot take a push gets the message over AMQ, so an
/// outage never stops agents talking; an explicit `--transport claude-peers`
/// asked for Claude Peers only and is refused instead. Returns the reason the
/// send output names.
fn amq_fallback_reason(
    preference: TransportPreference,
    why: &PeersUnavailable,
    target: &str,
) -> Result<String> {
    let reason = why.reason(target);
    if preference == TransportPreference::ClaudePeers {
        bail!(
            "{reason}. A Claude Peers message cannot reach it now; omit --transport to deliver over AMQ"
        );
    }
    Ok(reason)
}

/// The registration that owns `session`, provided it can receive a push.
fn reachable_claude_peer(
    session: &PeerSession,
    peers: &[ClaudePeer],
    processes: &ProcessTable,
) -> std::result::Result<String, Unreachable> {
    let jcode = session.provider == "jcode";
    // jcode's per-session servers deliver; older jcode shared one and dropped pushes.
    let delivering: Vec<ClaudePeer> = peers
        .iter()
        .filter(|p| {
            !jcode
                || p.pid
                    .is_some_and(|pid| processes.delivers_jcode_channel(pid))
        })
        .cloned()
        .collect();
    let here = canonical_or_raw(Path::new(&session.directory));
    if jcode
        && delivering
            .iter()
            .filter(|p| canonical_or_raw(Path::new(&p.cwd)) == here)
            .count()
            > 1
    {
        return Err(Unreachable::Ambiguous);
    }
    let id = select_claude_peer_id(
        session,
        &delivering,
        |pid| processes.host_of(pid),
        |pid| processes.yaran_session_of(pid),
    )
    .ok_or(Unreachable::Unregistered)?;
    let pid = peers
        .iter()
        .find(|peer| peer.id == id)
        .and_then(|peer| peer.pid);
    if !jcode && pid.and_then(|pid| processes.loads_peers_channel(pid)) == Some(false) {
        return Err(Unreachable::ChannelOff);
    }
    Ok(id)
}

/// Choose which Claude Peers registration owns `session`.
///
/// The working directory alone is not a key: the Claude Code daemon keeps
/// pre-warmed `bg-spare` sessions registered from an agent's own worktree,
/// and when a pane's conversation is continued or forked the daemon hosts
/// the new session in its own process while the pane's original process
/// stays registered with a queue nobody drains. Picking by list order, by
/// heartbeat, or by descent from the yaran TUI each landed messages in one of
/// those dead registrations.
///
/// So rank by host kind (daemon session, then pane, then anything else,
/// spares last), then by newest registration, then by heartbeat so the
/// choice stays deterministic.
///
/// Identity comes first: a registration whose process names its yaran agent
/// (`YARAN_SESSION_ID`, which every agent is launched with and its MCP server
/// inherits) belongs to that agent whatever its directory. A pane that
/// `/resume`d a conversation recorded elsewhere has moved its working
/// directory there, and would otherwise be unreachable at its own directory
/// and mistaken for the agent that lives in the other one. The directory is
/// only the fallback, for registrations that name no agent, and never hands
/// one agent another agent's registration.
fn select_claude_peer_id(
    session: &PeerSession,
    peers: &[ClaudePeer],
    host_of: impl Fn(u32) -> PeerHost,
    session_of: impl Fn(u32) -> Option<String>,
) -> Option<String> {
    let owner = |peer: &ClaudePeer| peer.pid.and_then(&session_of);
    let mut candidates: Vec<&ClaudePeer> = peers
        .iter()
        .filter(|peer| owner(peer).as_deref() == Some(session.id.as_str()))
        .collect();
    if candidates.is_empty() {
        let session_path = canonical_or_raw(Path::new(&session.directory));
        candidates = peers
            .iter()
            .filter(|peer| {
                owner(peer).is_none() && canonical_or_raw(Path::new(&peer.cwd)) == session_path
            })
            .collect();
    }
    if candidates.len() <= 1 {
        return candidates.first().map(|peer| peer.id.clone());
    }

    let key = |peer: &ClaudePeer| {
        (
            peer.pid.map_or(PeerHost::Client, &host_of),
            peer.registered_at.clone(),
            peer.last_seen.clone(),
        )
    };
    candidates
        .iter()
        .max_by(|a, b| key(a).cmp(&key(b)))
        .map(|peer| peer.id.clone())
}

/// One snapshot of the process table, taken once per command. A
/// registration's pid is the peer's MCP server; its ancestry tells who hosts
/// it and whether that host loaded the channel.
struct ProcessTable {
    system: System,
    yaran_pid: Option<u32>,
}

impl ProcessTable {
    fn snapshot(yaran_pid: Option<u32>) -> Self {
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing()
                .with_cmd(UpdateKind::Always)
                .with_environ(UpdateKind::Always),
        );
        Self { system, yaran_pid }
    }

    /// The yaran agent a registration's process belongs to: the
    /// `YARAN_SESSION_ID` (or legacy `DUX_SESSION_ID`) in its environment or
    /// its nearest ancestor's. `None` for a Claude yaran did not launch.
    fn yaran_session_of(&self, pid: u32) -> Option<String> {
        let mut current = sysinfo::Pid::from_u32(pid);
        for _ in 0..MAX_ANCESTRY_DEPTH {
            if self.yaran_pid == Some(current.as_u32()) {
                return None;
            }
            let proc = self.system.process(current)?;
            // Set but empty names no agent and stops the walk: jcode clears it
            // in its session MCP servers so the daemon's inherited id is skipped.
            if let Some(id) = session_id_in_environ(proc.environ()) {
                return Some(id).filter(|id| !id.is_empty());
            }
            current = proc.parent()?;
        }
        None
    }

    /// Whether the registration's process is a claude-peers server jcode runs
    /// for one session and delivers channel pushes from.
    fn delivers_jcode_channel(&self, pid: u32) -> bool {
        self.system
            .process(sysinfo::Pid::from_u32(pid))
            .is_some_and(|proc| {
                proc.environ().iter().any(|entry| {
                    entry.to_str().is_some_and(|e| {
                        e.starts_with("JCODE_MCP_CHANNEL_SESSION=") && !e.ends_with('=')
                    })
                })
            })
    }

    /// Whether a daemon spare, a daemon session host, or the yaran TUI is
    /// behind the registration.
    fn host_of(&self, pid: u32) -> PeerHost {
        let mut current = sysinfo::Pid::from_u32(pid);
        for _ in 0..MAX_ANCESTRY_DEPTH {
            if self.yaran_pid == Some(current.as_u32()) {
                return PeerHost::Pane;
            }
            let Some(proc) = self.system.process(current) else {
                return PeerHost::Client;
            };
            if let Some(kind) = daemon_host_kind(proc.cmd()) {
                return kind;
            }
            match proc.parent() {
                Some(parent) => current = parent,
                None => return PeerHost::Client,
            }
        }
        PeerHost::Client
    }

    /// Whether the nearest `claude` at or above the registration's MCP
    /// server loaded the claude-peers channel. `None` when no `claude` is
    /// found, which keeps the old behaviour of trusting the registration.
    fn loads_peers_channel(&self, pid: u32) -> Option<bool> {
        let mut current = sysinfo::Pid::from_u32(pid);
        for _ in 0..MAX_ANCESTRY_DEPTH {
            let proc = self.system.process(current)?;
            let command = proc.cmd();
            if command_loads_peers_channel(command) {
                return Some(true);
            }
            if command.first().and_then(|arg0| Path::new(arg0).file_name())
                == Some(OsStr::new("claude"))
            {
                return Some(false);
            }
            current = proc.parent()?;
        }
        None
    }
}

/// The yaran session id an environment names, empty when set empty.
/// `YARAN_SESSION_ID` wins, even set empty; `DUX_SESSION_ID` is the fallback
/// only when it is absent.
fn session_id_in_environ(environ: &[OsString]) -> Option<String> {
    let value_of = |key: &str| {
        environ.iter().find_map(|entry| {
            entry
                .to_str()?
                .strip_prefix(key)?
                .strip_prefix('=')
                .map(str::to_string)
        })
    };
    value_of("YARAN_SESSION_ID").or_else(|| value_of("DUX_SESSION_ID"))
}

/// Claude Code only pushes `server:` channel messages it was started with
/// `--dangerously-load-development-channels server:claude-peers` for; its
/// in-place relaunch (after an update, for example) rebuilds argv without it.
fn command_loads_peers_channel(command: &[OsString]) -> bool {
    const FLAG: &str = "--dangerously-load-development-channels";
    let names = |value: &str| {
        value
            .split([',', ' '])
            .any(|name| name == "server:claude-peers")
    };
    let mut in_flag = false;
    for arg in command {
        let arg = arg.to_string_lossy();
        if let Some(value) = arg
            .strip_prefix(FLAG)
            .and_then(|rest| rest.strip_prefix('='))
        {
            if names(value) {
                return true;
            }
            in_flag = false;
        } else if arg == FLAG {
            in_flag = true;
        } else if arg.starts_with('-') {
            in_flag = false;
        } else if in_flag && names(&arg) {
            return true;
        }
    }
    false
}

/// Recognise the Claude Code daemon's process roles from a command line.
/// `bg-spare` is checked first because a spare runs underneath its own
/// `bg-pty-host`, and it is the spare that must lose.
fn daemon_host_kind(command: &[OsString]) -> Option<PeerHost> {
    let has = |needle: &str| command.iter().any(|arg| arg == needle);
    if has("bg-spare") || has("--bg-spare") {
        Some(PeerHost::Spare)
    } else if has("bg-pty-host") || has("--bg-pty-host") {
        Some(PeerHost::DaemonSession)
    } else {
        None
    }
}

/// PID of the yaran process holding this config directory, from its lockfile.
fn yaran_tui_pid(paths: &YaranPaths) -> Option<u32> {
    fs::read_to_string(&paths.lock_path)
        .ok()?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

/// The session whose directory contains `cwd`, preferring the deepest one.
/// Two sessions at the same depth (a shared workspace) make the sender
/// ambiguous, which is an error rather than a guess.
/// The handle of the agent session whose directory holds `cwd`, the nearest
/// one, as `yaran peer send` infers its sender. `None` when no session (or
/// more than one at the same depth) holds it, or the store cannot be read.
pub(crate) fn agent_handle_for_cwd(cwd: &Path, sessions: &[PeerSession]) -> Option<String> {
    session_for_cwd(cwd, sessions)
        .ok()
        .flatten()
        .map(|session| session.agent_handle().to_string())
}

fn session_for_cwd<'a>(cwd: &Path, sessions: &'a [PeerSession]) -> Result<Option<&'a PeerSession>> {
    let cwd = canonical_or_raw(cwd);
    let mut nearest = None;
    let mut ambiguous = false;
    for session in sessions {
        let path = canonical_or_raw(Path::new(&session.directory));
        if cwd == path || cwd.starts_with(&path) {
            let depth = path.components().count();
            match nearest {
                Some((nearest_depth, _)) if depth < nearest_depth => {}
                Some((nearest_depth, _)) if depth == nearest_depth => ambiguous = true,
                _ => {
                    nearest = Some((depth, session));
                    ambiguous = false;
                }
            }
        }
    }
    if ambiguous {
        bail!(
            "cannot infer sender because multiple Yaran sessions share this workspace; pass --from <agent_handle>"
        );
    }
    Ok(nearest.map(|(_, session)| session))
}

fn canonical_or_raw(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Every name a session answers to as a target: id, handle, branch, title,
/// and its directory's name (raw and sanitised).
fn session_aliases(session: &PeerSession) -> HashSet<String> {
    let mut aliases = HashSet::new();
    aliases.insert(session.id.clone());
    aliases.insert(session.agent_handle().to_string());
    if let Some(branch) = &session.branch {
        aliases.insert(branch.clone());
    }
    if let Some(title) = &session.title {
        aliases.insert(title.clone());
    }
    if let Some(name) = Path::new(&session.directory)
        .file_name()
        .and_then(|name| name.to_str())
    {
        aliases.insert(name.to_string());
        let sanitized = amq_handle(name);
        if !sanitized.is_empty() {
            aliases.insert(sanitized);
        }
    }
    aliases
}

#[cfg(test)]
#[path = "router_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "router_jcode_tests.rs"]
mod jcode_tests;
