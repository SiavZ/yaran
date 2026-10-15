//! Keeping a folder board in step with the other machines that share it.
//!
//! With `[board] sync = "git"`, the board folder lives inside a git
//! repository (a notes vault, say) whose branch has an upstream, and a sync
//! is one round of:
//!
//! 1. **Commit** this machine's board changes: only the board folder's paths,
//!    whatever else is modified or staged in the repository, under the
//!    board's lock so no half-written note is ever committed.
//! 2. **Fetch** the upstream.
//! 3. **Merge** it: a fast-forward when this machine has nothing of its own, a
//!    merge commit otherwise. Never a rebase, which would rewrite commits
//!    other tools on this machine may have made. Git refuses a merge that
//!    would overwrite uncommitted work, and that refusal is reported and
//!    retried on the next round, never forced. When two machines changed the
//!    same card, the edit with the later `updated` time wins (ties go to the
//!    larger note, so every machine settles the same way); a conflict outside
//!    the board folder is never touched: the merge is undone and reported.
//! 4. **Push** to the upstream, once more round if the remote moved meanwhile.
//!
//! Nothing runs while the repository is in the middle of somebody else's
//! merge, rebase or cherry-pick. Every git call has a hard time limit, never
//! prompts for credentials (`GIT_TERMINAL_PROMPT=0`, and ssh in batch mode
//! unless the user configured an ssh command of their own), and its error
//! text is sanitized before it is shown.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, Utc};

use super::store::BoardStore;
use super::{Card, markdown};
use crate::bounded_command::{CommandOutcome, DEFAULT_READER_DRAIN, run_command_with_timeout};

/// How a shared board is kept in step.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SyncMode {
    /// Not by yaran: something else (a sync app, a person) does it, or the
    /// board is not shared.
    #[default]
    Off,
    /// Through the git repository the board folder is in.
    Git,
}

impl SyncMode {
    /// The config value, case-insensitively. `None` for anything else.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "off" | "none" | "no" | "false" => Some(SyncMode::Off),
            "git" => Some(SyncMode::Git),
            _ => None,
        }
    }
}

/// Time limit for git calls that stay on this machine.
const LOCAL_TIMEOUT: Duration = Duration::from_secs(30);
/// Time limit for a fetch or a push.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);
/// Rounds of fetch, merge and push before giving up on a remote that keeps
/// moving under us.
const PUSH_ROUNDS: usize = 2;

/// What one sync did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncReport {
    /// The board notes this machine committed (file names).
    pub committed: Vec<String>,
    /// Commits taken from the remote.
    pub received: u32,
    /// Whether this machine's commits went to the remote.
    pub pushed: bool,
    /// Notes both sides had changed, settled by keeping the newer card.
    pub settled: Vec<String>,
}

impl SyncReport {
    /// Whether anything moved in either direction.
    pub fn changed_anything(&self) -> bool {
        !self.committed.is_empty() || self.received > 0 || self.pushed
    }

    /// One sentence for a status line or the CLI.
    pub fn summary(&self) -> String {
        if !self.changed_anything() {
            return "The shared board is in step with its remote; nothing changed.".to_string();
        }
        let mut parts = Vec::new();
        if !self.committed.is_empty() {
            parts.push(format!(
                "committed {} changed card note{}",
                self.committed.len(),
                if self.committed.len() == 1 { "" } else { "s" }
            ));
        }
        if self.received > 0 {
            parts.push(format!(
                "took {} commit{} from the remote",
                self.received,
                if self.received == 1 { "" } else { "s" }
            ));
        }
        if self.pushed {
            parts.push("pushed".to_string());
        }
        let mut sentence = format!("Synced the shared board: {}.", parts.join(", "));
        if !self.settled.is_empty() {
            sentence.push_str(&format!(
                " Both sides had changed {}; the newer edit of each was kept.",
                self.settled.join(", ")
            ));
        }
        sentence
    }
}

/// One finished sync, as a surface shows it.
#[derive(Clone, Debug)]
pub struct SyncOutcome {
    pub at: DateTime<Utc>,
    pub result: Result<SyncReport, String>,
}

/// Run one sync of `store`'s folder through git.
pub fn sync_with_git(store: &BoardStore) -> Result<SyncReport> {
    if !store.is_folder() {
        bail!(
            "the board is not a folder, so there is nothing to sync; set [board] dir to a \
             folder inside a git repository"
        );
    }
    let dir = store.path();
    std::fs::create_dir_all(dir)
        .with_context(|| format!("could not create the board folder {}", dir.display()))?;
    let repo = Repo::open(dir)?;
    repo.refuse_if_busy()?;
    let upstream = repo.upstream()?;

    let mut report = SyncReport {
        committed: store.with_lock(|| repo.commit_board())?,
        ..SyncReport::default()
    };
    for round in 0..PUSH_ROUNDS {
        repo.git_ok(
            &["fetch", "--quiet", "--", &upstream.remote],
            NETWORK_TIMEOUT,
        )
        .context("could not fetch the board's remote")?;
        let (ahead, behind) = repo.ahead_behind()?;
        if behind > 0 {
            report.received += behind;
            let settled = store.with_lock(|| repo.merge_upstream(ahead == 0))?;
            report.settled.extend(settled);
        }
        let (ahead, _) = repo.ahead_behind()?;
        if ahead == 0 {
            return Ok(report);
        }
        let refspec = format!("HEAD:{}", upstream.merge_ref);
        let push = repo.git(
            &["push", "--quiet", "--", &upstream.remote, &refspec],
            NETWORK_TIMEOUT,
        )?;
        if push.ok {
            report.pushed = true;
            return Ok(report);
        }
        if round + 1 == PUSH_ROUNDS {
            bail!("could not push the board: {}", push.stderr);
        }
        // The remote most likely moved between the fetch and the push: take
        // its new commits and try again.
    }
    Ok(report)
}

/// The branch's upstream, as the remote name and the remote's ref.
struct Upstream {
    remote: String,
    /// Fully qualified (`refs/heads/main`), so it can never read as an option.
    merge_ref: String,
}

/// What one git call said.
struct GitOutput {
    ok: bool,
    stdout: Vec<u8>,
    /// Sanitized and trimmed.
    stderr: String,
}

/// The repository holding the board folder.
struct Repo {
    root: PathBuf,
    /// The board folder as a pathspec from the repository's top level.
    pathspec: String,
    /// The board folder relative to the top level, `/`-separated; empty when
    /// the folder is the top level itself.
    relative: String,
    /// Extra environment for calls that reach the network.
    ssh_batch: bool,
}

impl Repo {
    fn open(dir: &Path) -> Result<Self> {
        let probe = git_in(dir, &["rev-parse", "--show-toplevel"], LOCAL_TIMEOUT, false)?;
        if !probe.ok {
            bail!(
                "the board folder {} is not inside a git repository, so sync = \"git\" has \
                 nothing to sync through ({})",
                dir.display(),
                probe.stderr
            );
        }
        let root = PathBuf::from(String::from_utf8_lossy(&probe.stdout).trim().to_string());
        let canonical_dir = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
        let canonical_root = root.canonicalize().unwrap_or_else(|_| root.clone());
        let relative = canonical_dir
            .strip_prefix(&canonical_root)
            .map(Path::to_path_buf)
            .unwrap_or_default();
        let relative = relative.to_string_lossy().into_owned();
        // `top` anchors the path at the top level and `literal` keeps a
        // folder name holding `*` or `?` from being read as a pattern.
        let pathspec = if relative.is_empty() {
            ":(top,literal).".to_string()
        } else {
            format!(":(top,literal){relative}")
        };
        let mut repo = Self {
            root: canonical_root,
            pathspec,
            relative,
            ssh_batch: false,
        };
        repo.ssh_batch = std::env::var_os("GIT_SSH_COMMAND").is_none()
            && std::env::var_os("GIT_SSH").is_none()
            && !repo
                .git(&["config", "--get", "core.sshCommand"], LOCAL_TIMEOUT)?
                .ok;
        Ok(repo)
    }

    fn git(&self, args: &[&str], timeout: Duration) -> Result<GitOutput> {
        git_in(&self.root, args, timeout, self.ssh_batch)
    }

    /// Run git and fail with its error text when it fails.
    fn git_ok(&self, args: &[&str], timeout: Duration) -> Result<GitOutput> {
        let out = self.git(args, timeout)?;
        if !out.ok {
            bail!("git {} failed: {}", args.join(" "), out.stderr);
        }
        Ok(out)
    }

    /// Whether `name` (a `--git-path` name such as `MERGE_HEAD`) exists.
    fn has_git_path(&self, name: &str) -> Result<bool> {
        let out = self.git_ok(&["rev-parse", "--git-path", name], LOCAL_TIMEOUT)?;
        let path = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim().to_string());
        let path = if path.is_absolute() {
            path
        } else {
            self.root.join(path)
        };
        Ok(path.exists())
    }

    fn refuse_if_busy(&self) -> Result<()> {
        for marker in [
            "MERGE_HEAD",
            "rebase-merge",
            "rebase-apply",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
        ] {
            if self.has_git_path(marker)? {
                bail!(
                    "{} is in the middle of a merge, rebase or cherry-pick; the board syncs \
                     once that is finished",
                    self.root.display()
                );
            }
        }
        Ok(())
    }

    fn upstream(&self) -> Result<Upstream> {
        let branch = self.git(
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
            LOCAL_TIMEOUT,
        )?;
        if !branch.ok {
            bail!(
                "{} has no branch checked out (a detached HEAD), so the board has nowhere \
                 to sync",
                self.root.display()
            );
        }
        let branch = String::from_utf8_lossy(&branch.stdout).trim().to_string();
        let config = |key: &str| -> Result<Option<String>> {
            let out = self.git(
                &["config", "--get", &format!("branch.{branch}.{key}")],
                LOCAL_TIMEOUT,
            )?;
            Ok(out
                .ok
                .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
                .filter(|value| !value.is_empty()))
        };
        match (config("remote")?, config("merge")?) {
            (Some(remote), Some(merge_ref)) if remote != "." => Ok(Upstream { remote, merge_ref }),
            _ => bail!(
                "branch {branch} of {} has no upstream to sync the board with; set one with \
                 `git branch --set-upstream-to`",
                self.root.display()
            ),
        }
    }

    /// Commit whatever changed in the board folder, and only that. Returns the
    /// file names committed.
    fn commit_board(&self) -> Result<Vec<String>> {
        let status = self.git_ok(
            &[
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--",
                &self.pathspec,
            ],
            LOCAL_TIMEOUT,
        )?;
        let changed = porcelain_paths(&status.stdout);
        if changed.is_empty() {
            return Ok(Vec::new());
        }
        self.git_ok(&["add", "-A", "--", &self.pathspec], LOCAL_TIMEOUT)?;
        let names: Vec<String> = changed
            .iter()
            .map(|path| {
                Path::new(path)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.clone())
            })
            .collect();
        let message = commit_message(&names);
        // Naming the pathspec commits those paths alone, whatever else is
        // staged in the repository at the moment.
        self.git_ok(
            &["commit", "--quiet", "-m", &message, "--", &self.pathspec],
            LOCAL_TIMEOUT,
        )?;
        Ok(names)
    }

    fn ahead_behind(&self) -> Result<(u32, u32)> {
        let out = self.git_ok(
            &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
            LOCAL_TIMEOUT,
        )?;
        let text = String::from_utf8_lossy(&out.stdout);
        let mut counts = text.split_whitespace().map(str::parse::<u32>);
        match (counts.next(), counts.next()) {
            (Some(Ok(ahead)), Some(Ok(behind))) => Ok((ahead, behind)),
            _ => bail!("git rev-list gave an answer the board sync cannot read: {text:?}"),
        }
    }

    /// Bring the upstream's commits in. Returns the notes settled by keeping
    /// the newer card.
    fn merge_upstream(&self, fast_forward: bool) -> Result<Vec<String>> {
        if fast_forward {
            let out = self.git(
                &["merge", "--ff-only", "--quiet", "@{upstream}"],
                LOCAL_TIMEOUT,
            )?;
            if !out.ok {
                bail!(
                    "could not take the remote's board changes into {}: {}",
                    self.root.display(),
                    out.stderr
                );
            }
            return Ok(Vec::new());
        }
        let out = self.git(
            &["merge", "--no-edit", "--quiet", "@{upstream}"],
            LOCAL_TIMEOUT,
        )?;
        if out.ok {
            return Ok(Vec::new());
        }
        if !self.has_git_path("MERGE_HEAD")? {
            // Refused before it started (uncommitted work in the way): nothing
            // to undo, and the next round tries again.
            bail!(
                "could not merge the remote's board changes into {}: {}",
                self.root.display(),
                out.stderr
            );
        }
        match self.settle_conflicts() {
            Ok(settled) => Ok(settled),
            Err(err) => {
                let _ = self.git(&["merge", "--abort"], LOCAL_TIMEOUT);
                Err(err)
            }
        }
    }

    /// Settle a stopped merge whose conflicts are all board notes, by keeping
    /// the newer card of each, and conclude it. Anything else is an error, and
    /// the caller undoes the merge.
    fn settle_conflicts(&self) -> Result<Vec<String>> {
        let out = self.git_ok(
            &["diff", "--name-only", "-z", "--diff-filter=U"],
            LOCAL_TIMEOUT,
        )?;
        let conflicted: Vec<String> = out
            .stdout
            .split(|b| *b == 0)
            .filter(|path| !path.is_empty())
            .map(|path| String::from_utf8_lossy(path).into_owned())
            .collect();
        let outside: Vec<&String> = conflicted
            .iter()
            .filter(|path| !self.is_board_note(path))
            .collect();
        if !outside.is_empty() {
            bail!(
                "the remote's changes conflict with this machine's outside the board folder \
                 ({}); the merge was undone, so resolve it in {} by hand",
                outside
                    .iter()
                    .map(|p| p.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
                self.root.display()
            );
        }
        let mut settled = Vec::new();
        for path in &conflicted {
            let ours = self.stage(2, path)?;
            let theirs = self.stage(3, path)?;
            let name = Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            match newer_note(&name, ours.as_deref(), theirs.as_deref()) {
                Some(bytes) => {
                    std::fs::write(self.root.join(path), bytes)
                        .with_context(|| format!("could not write {path}"))?;
                    self.git_ok(&["add", "--", path], LOCAL_TIMEOUT)?;
                }
                None => {
                    self.git_ok(&["rm", "--quiet", "--cached", "--", path], LOCAL_TIMEOUT)?;
                    let _ = std::fs::remove_file(self.root.join(path));
                }
            }
            settled.push(name);
        }
        self.git_ok(&["commit", "--quiet", "--no-edit"], LOCAL_TIMEOUT)?;
        Ok(settled)
    }

    /// Whether `path` (from the top level) is a note directly in the board
    /// folder.
    fn is_board_note(&self, path: &str) -> bool {
        let name = if self.relative.is_empty() {
            Some(path)
        } else {
            path.strip_prefix(self.relative.as_str())
                .and_then(|rest| rest.strip_prefix('/'))
        };
        name.is_some_and(|name| !name.contains('/') && name.ends_with(".md"))
    }

    /// The bytes of `path` at merge stage `stage`, or `None` when that side
    /// deleted it.
    fn stage(&self, stage: u8, path: &str) -> Result<Option<Vec<u8>>> {
        let spec = format!(":{stage}:{path}");
        let out = self.git(&["cat-file", "blob", &spec], LOCAL_TIMEOUT)?;
        Ok(out.ok.then_some(out.stdout))
    }
}

/// Which side of a conflicted note to keep: the card updated later; on a tie
/// the larger note, so every machine settling the same conflict picks the same
/// side. A side that deleted the note loses to one that changed it (a
/// changed card is news; a deleted one was only history being pruned). `None`
/// when both sides deleted it.
fn newer_note(name: &str, ours: Option<&[u8]>, theirs: Option<&[u8]>) -> Option<Vec<u8>> {
    let stem = name.trim_end_matches(".md");
    let card = |bytes: &[u8]| -> Option<Card> {
        markdown::parse(
            &String::from_utf8_lossy(bytes),
            stem,
            DateTime::<Utc>::MIN_UTC,
        )
        .ok()
        .flatten()
    };
    match (ours, theirs) {
        (None, None) => None,
        (Some(one), None) | (None, Some(one)) => Some(one.to_vec()),
        (Some(ours), Some(theirs)) => {
            let ours_card = card(ours);
            let theirs_card = card(theirs);
            let ours_at = ours_card.as_ref().map(|c| c.updated_at);
            let theirs_at = theirs_card.as_ref().map(|c| c.updated_at);
            let keep_ours = match ours_at.cmp(&theirs_at) {
                std::cmp::Ordering::Greater => true,
                std::cmp::Ordering::Less => false,
                std::cmp::Ordering::Equal => ours >= theirs,
            };
            let kept_bytes = if keep_ours { ours } else { theirs };
            // The newer card wins, but a conversation is only ever added to:
            // the messages the older side gained are carried over, so a reply
            // written on each machine between two syncs survives on both.
            if let (Some(ours_card), Some(theirs_card)) = (ours_card, theirs_card) {
                let (mut kept, other) = if keep_ours {
                    (ours_card, theirs_card)
                } else {
                    (theirs_card, ours_card)
                };
                if kept.absorb_conversation(&other) {
                    return Some(markdown::render(&kept).into_bytes());
                }
            }
            Some(kept_bytes.to_vec())
        }
    }
}

/// The commit message for the notes in `names`, as a plain sentence.
fn commit_message(names: &[String]) -> String {
    const LISTED: usize = 6;
    let ids: Vec<&str> = names
        .iter()
        .map(|name| name.trim_end_matches(".md"))
        .collect();
    let mut listed = ids
        .iter()
        .take(LISTED)
        .copied()
        .collect::<Vec<_>>()
        .join(", ");
    if ids.len() > LISTED {
        listed.push_str(&format!(" and {} more", ids.len() - LISTED));
    }
    format!("Update the shared board: {listed}")
}

/// The paths of a `status --porcelain=v1 -z` listing. A rename record carries
/// its source as an extra NUL-separated field, which is skipped.
fn porcelain_paths(raw: &[u8]) -> Vec<String> {
    let mut paths = Vec::new();
    let mut fields = raw.split(|b| *b == 0).filter(|f| !f.is_empty());
    while let Some(record) = fields.next() {
        if record.len() < 4 {
            continue;
        }
        let (status, path) = record.split_at(3);
        paths.push(String::from_utf8_lossy(path).into_owned());
        if matches!(status[0], b'R' | b'C') {
            fields.next();
        }
    }
    paths
}

/// Run git in `dir` with a hard time limit, never prompting.
fn git_in(dir: &Path, args: &[&str], timeout: Duration, ssh_batch: bool) -> Result<GitOutput> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        // English messages, so an error read in a bug report reads the same
        // everywhere; nothing here is parsed from them.
        .env("LC_ALL", "C");
    if ssh_batch {
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    let label = format!("git {}", args.first().copied().unwrap_or(""));
    match run_command_with_timeout(cmd, timeout, DEFAULT_READER_DRAIN, &label) {
        CommandOutcome::Completed(output) => Ok(GitOutput {
            ok: output.status.success(),
            stderr: crate::sanitize::for_terminal(String::from_utf8_lossy(&output.stderr).trim()),
            stdout: output.stdout,
        }),
        CommandOutcome::TimedOut => Err(anyhow!(
            "{label} in {} took longer than {}s and was stopped",
            dir.display(),
            timeout.as_secs()
        )),
        CommandOutcome::Failed(why) => Err(anyhow!("could not run {label}: {why}")),
    }
}

/// Runs syncs on a background thread: one straight away, one every `every`,
/// and one shortly after each [`BoardSyncer::poke`] (a local change), with
/// pokes that arrive together folded into one sync. Stops when dropped, once
/// any sync in flight has finished.
pub struct BoardSyncer {
    poke: mpsc::Sender<()>,
    rx: mpsc::Receiver<SyncOutcome>,
}

/// How long after a poke the sync starts, so a burst of changes (an agent
/// posting several cards) goes out as one commit.
pub const POKE_SETTLE: Duration = Duration::from_secs(3);

impl BoardSyncer {
    pub fn spawn(store: BoardStore, every: Duration) -> std::io::Result<Self> {
        Self::spawn_with(store, every, POKE_SETTLE, sync_with_git)
    }

    /// [`BoardSyncer::spawn`] with the sync itself and the settle time
    /// supplied, for tests.
    pub fn spawn_with(
        store: BoardStore,
        every: Duration,
        settle: Duration,
        sync: fn(&BoardStore) -> Result<SyncReport>,
    ) -> std::io::Result<Self> {
        let (poke_tx, poke_rx) = mpsc::channel::<()>();
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("yaran-board-sync".to_string())
            .spawn(move || {
                let mut next_round = Instant::now();
                let mut poked: Option<Instant> = None;
                loop {
                    let now = Instant::now();
                    let due = poked.map_or(next_round, |at| at.min(next_round));
                    if due <= now {
                        let result =
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sync(&store)))
                                .unwrap_or_else(|_| Err(anyhow!("the board sync panicked")));
                        let outcome = SyncOutcome {
                            at: Utc::now(),
                            result: result.map_err(|err| format!("{err:#}")),
                        };
                        if tx.send(outcome).is_err() {
                            return;
                        }
                        next_round = Instant::now() + every;
                        poked = None;
                        continue;
                    }
                    match poke_rx.recv_timeout(due - now) {
                        Ok(()) => {
                            poked.get_or_insert_with(|| Instant::now() + settle);
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
            })?;
        Ok(Self { poke: poke_tx, rx })
    }

    /// Ask for a sync soon: something on this machine changed the board.
    pub fn poke(&self) {
        let _ = self.poke.send(());
    }

    /// The newest finished sync since the last call, if any.
    pub fn latest(&self) -> Option<SyncOutcome> {
        self.rx.try_iter().last()
    }

    /// Wait up to `timeout` for the next finished sync. For tests and tools.
    pub fn next_within(&self, timeout: Duration) -> Option<SyncOutcome> {
        self.rx.recv_timeout(timeout).ok()
    }
}

#[cfg(test)]
#[path = "sync_tests.rs"]
mod tests;
