//! One running yaran in a container, and the ways a journey reaches it.
//!
//! Three kinds of client exist, and they are the three places a request to yaran
//! can come from:
//!
//! - **The network**: the test process on the host, through the port Docker
//!   published. yaran sees the Docker bridge's address, which is neither loopback
//!   nor a tailnet address. [`Yaran::client`].
//! - **This machine**: `curl` run inside the container against loopback.
//!   [`Yaran::inside`].
//! - **A tailnet peer**: the host again, through a published port the container
//!   relays onto the stand-in Tailscale address FROM a peer address of its own
//!   ([`crate::TAILNET_PEER_IP`]), so the connection arrives on yaran's Tailscale
//!   listener from a tailnet address that is not yaran's. [`Yaran::client_on`] with
//!   a relay port.
//!
//! Every published port binds the host's loopback only (see
//! [`crate::container`]). The container is removed when the [`Yaran`] drops,
//! whether the journey passed, panicked or ran out of time, and a journey that
//! fails prints everything the container said (see [`crate::journey`]).

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::time::Duration;

use base64::Engine as _;
use testcontainers::core::{AccessMode, ExecCommand, IntoContainerPort, Mount, WaitFor};
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage, ImageExt};

use crate::client::{Client, Response, parse_raw_response};
use crate::container::{identity, labelled, loopback_publish};
use crate::image::{JourneyNetwork, Reaper, journey_image, yaran_binary};
use crate::util::{LogBuffer, eventually, shell_quote, suffix};
use crate::{TAILNET_IP, TAILNET_PEER_IP, YARAN_PORT};

/// yaran's config directory inside the journey image (the entrypoint's
/// `YARAN_HOME`).
const YARAN_HOME: &str = "/data/yaran";

/// Where yaran listens inside its container.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bind {
    /// `--bind 0.0.0.0:3890`: reachable through the published port, so the
    /// host's requests arrive from the network.
    Everywhere,
    /// No `--bind`: loopback plus the Tailscale leg when the stand-in reports
    /// one, exactly as an unconfigured `yaran server` listens. Nothing reaches it
    /// from the host except through a relay.
    Local,
}

/// Which serving mode runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Launch {
    /// `yaran server`.
    Server,
    /// The terminal UI in tmux. Serving then needs either
    /// `[server] serve_while_tui = true` (a seed hook) or the
    /// `start-web-server` palette command (the flip, sent with [`Yaran::tmux_keys`]).
    Tui,
}

/// How to start one yaran. Build with [`YaranOptions::exposed`] or
/// [`YaranOptions::local`] and the `with_*` methods.
#[derive(Debug, Clone)]
pub struct YaranOptions {
    bind: Bind,
    launch: Launch,
    fake_tailscale: bool,
    restart_loop: bool,
    relays: Vec<(u16, String)>,
    published: Vec<u16>,
    env: BTreeMap<String, String>,
    hooks: Vec<(String, String)>,
    network: Option<String>,
}

impl YaranOptions {
    /// yaran on every interface: the host is a client from the network.
    pub fn exposed() -> Self {
        Self::new(Bind::Everywhere)
    }

    /// yaran on loopback (and the stand-in tailnet, with [`Self::with_tailnet`]).
    pub fn local() -> Self {
        Self::new(Bind::Local)
    }

    fn new(bind: Bind) -> Self {
        Self {
            bind,
            launch: Launch::Server,
            fake_tailscale: false,
            restart_loop: false,
            relays: Vec::new(),
            published: Vec::new(),
            env: BTreeMap::new(),
            hooks: Vec::new(),
            network: None,
        }
    }

    /// Put the stand-in `tailscale` CLI on PATH (answering with [`TAILNET_IP`])
    /// and relay `relay_port` onto yaran's Tailscale listener from the peer's own
    /// address ([`TAILNET_PEER_IP`]), so the host can be a tailnet peer through it.
    #[must_use]
    pub fn with_tailnet(mut self, relay_port: u16) -> Self {
        self.fake_tailscale = true;
        self.relays.push((
            relay_port,
            format!("{TAILNET_IP}:{YARAN_PORT},bind={TAILNET_PEER_IP}"),
        ));
        self
    }

    /// Let yaran check Tailscale (it finds none, unless [`Self::with_tailnet`]
    /// puts the stand-in there). The image otherwise starts `yaran server` with
    /// `--no-tailscale`, and a yaran that cannot check whether a Funnel or
    /// forward relays the internet onto its port counts loopback as the
    /// network, so a journey that needs this machine to BE this machine asks
    /// for the check.
    #[must_use]
    pub fn with_tailscale_checks(self) -> Self {
        self.with_env("YARAN_NO_TAILSCALE", "0")
    }

    /// Relay `port` onto loopback with no forwarding header, the way a raw TCP
    /// forward (a `tailscale serve` TCP forward, a port forwarder) reaches yaran.
    #[must_use]
    pub fn with_loopback_relay(mut self, port: u16) -> Self {
        self.relays.push((port, format!("127.0.0.1:{YARAN_PORT}")));
        self
    }

    /// Publish a container port without relaying it, for a sidecar that shares
    /// this container's network namespace (nginx, Caddy) and listens on it.
    #[must_use]
    pub fn with_published(mut self, port: u16) -> Self {
        self.published.push(port);
        self
    }

    /// An environment variable for the container (and so for yaran and the
    /// providers it spawns).
    #[must_use]
    pub fn with_env(mut self, key: &str, value: &str) -> Self {
        self.env.insert(key.to_string(), value.to_string());
        self
    }

    /// A shell hook run before yaran starts, after the canonical config exists.
    /// Hooks run in the order they were added.
    #[must_use]
    pub fn with_hook(mut self, script: &str) -> Self {
        let name = format!("{:02}-journey.sh", self.hooks.len() + 10);
        self.hooks.push((name, script.to_string()));
        self
    }

    /// Set the web password before yaran starts, the way a person does:
    /// `yaran config set server.auth.password --stdin`.
    #[must_use]
    pub fn with_password(self, password: &str) -> Self {
        let script = format!(
            "set -e\n{}\n",
            secret_command("server.auth.password", password)
        );
        self.with_hook(&script)
    }

    /// Set one config value before yaran starts, through `yaran config set`.
    #[must_use]
    pub fn with_config(self, path: &str, value: &str) -> Self {
        let script = format!(
            "set -e\nyaran config set {} {}\n",
            shell_quote(path),
            shell_quote(value)
        );
        self.with_hook(&script)
    }

    /// Start yaran again whenever it exits, so [`Yaran::restart_process`] gives a
    /// new run behind the same ports and state.
    #[must_use]
    pub fn with_restart_loop(mut self) -> Self {
        self.restart_loop = true;
        self
    }

    /// Run the terminal UI in tmux instead of `yaran server`.
    #[must_use]
    pub fn with_tui(mut self) -> Self {
        self.launch = Launch::Tui;
        // The terminal UI greets a first run with screens that would sit in
        // front of the palette; the screenshot driver turns them off the same way.
        self.with_hook(
            "set -e\n\
             sed -i \
               -e 's/^disable_automated_welcome_screen = false$/disable_automated_welcome_screen = true/' \
               -e 's/^disable_release_notes = false$/disable_release_notes = true/' \
               -e 's/^github_integration = true$/github_integration = false/' \
               \"$YARAN_HOME/config.toml\"\n",
        )
    }

    /// Join a journey's own Docker network, so a browser container on it can
    /// reach yaran by its address there.
    #[must_use]
    pub fn with_network(mut self, network: &JourneyNetwork) -> Self {
        self.network = Some(network.name().to_string());
        self
    }
}

/// The `yaran config set <path> --stdin` command line, fed `secret` through a
/// pipe. Base64 on the way in so no quoting can change a byte of it, and never
/// on the command line of yaran itself.
fn secret_command(path: &str, secret: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(secret.as_bytes());
    format!(
        "printf %s {} | base64 -d | yaran config set {} --stdin",
        shell_quote(&encoded),
        shell_quote(path)
    )
}

/// What a command run inside the container did.
#[derive(Debug, Clone)]
pub struct Exec {
    /// The exit code.
    pub code: i64,
    /// Everything it printed on stdout, decoded lossily.
    pub stdout: String,
    /// Everything it printed on stderr, decoded lossily.
    pub stderr: String,
}

impl Exec {
    /// Both streams, for an assertion message or a substring check.
    pub fn output(&self) -> String {
        format!("{}{}", self.stdout, self.stderr)
    }
}

/// One running yaran. Dropping it removes the container.
#[derive(Debug)]
pub struct Yaran {
    container: ContainerAsync<GenericImage>,
    // After the container, so it drops second: it removes a container a
    // cancelled start never handed over, and is a no-op otherwise.
    _reaper: Reaper,
    // Last, so it drops after the container that was on it: the network this
    // yaran made for itself when the journey named none.
    _own_network: Option<JourneyNetwork>,
    logs: LogBuffer,
    bind: Bind,
    name: String,
}

impl Yaran {
    /// Start a yaran and wait until it answers.
    ///
    /// # Panics
    ///
    /// When the container does not start, or, for `yaran server`, its container stops before yaran
    /// answers `/healthz` or yaran does not answer within 60 seconds.
    pub async fn start(options: YaranOptions) -> Yaran {
        let (image_name, tag) = journey_image().await;
        // A network of its own unless the journey shares one, so no journey
        // container ever sits on Docker's default bridge beside unrelated
        // containers. Made before the reaper, so a cancelled start drops the
        // reaper (removing the container) first and the network after it.
        let own_network = match options.network {
            Some(_) => None,
            None => Some(JourneyNetwork::create()),
        };
        let network = options
            .network
            .clone()
            .or_else(|| own_network.as_ref().map(|n| n.name().to_string()))
            .expect("a network");
        let (name, reaper, logs) = identity("yaran");

        let mut ports = vec![YARAN_PORT];
        ports.extend(options.relays.iter().map(|(port, _)| *port));
        ports.extend(options.published.iter().copied());
        let mut image = GenericImage::new(image_name, tag)
            .with_wait_for(WaitFor::message_on_stdout("entrypoint: "));
        for port in &ports {
            image = image.with_exposed_port(port.tcp());
        }

        let binary = yaran_binary();
        let mut request = labelled(image.into(), &name, &logs)
            .with_host_config_modifier(loopback_publish(ports))
            .with_mount(
                Mount::bind_mount(binary.to_string_lossy(), "/usr/local/bin/yaran")
                    .with_access_mode(AccessMode::ReadOnly),
            )
            .with_env_var("YARAN_PORT", YARAN_PORT.to_string())
            .with_env_var("YARAN_TAIL_LOG", "1")
            .with_startup_timeout(Duration::from_secs(120));

        request = match options.bind {
            Bind::Everywhere => request,
            Bind::Local => request.with_env_var("YARAN_BIND", "local"),
        };
        if options.launch == Launch::Tui {
            request = request.with_env_var("YARAN_LAUNCH", "tui");
        }
        if options.fake_tailscale {
            request = request
                .with_env_var("YARAN_FAKE_TAILSCALE", "1")
                .with_cap_add("NET_ADMIN");
        }
        if options.restart_loop {
            request = request.with_env_var("YARAN_RESTART_LOOP", "1");
        }
        if !options.relays.is_empty() {
            let relays: Vec<String> = options
                .relays
                .iter()
                .map(|(port, target)| format!("{port}={target}"))
                .collect();
            request = request.with_env_var("YARAN_RELAYS", relays.join(" "));
        }
        for (key, value) in &options.env {
            request = request.with_env_var(key, value);
        }
        for (hook, script) in &options.hooks {
            request = request.with_copy_to(
                format!("/journey/seed.d/{hook}"),
                script.clone().into_bytes(),
            );
        }
        request = request.with_network(&network);

        let container = request
            .start()
            .await
            .unwrap_or_else(|err| panic!("start the yaran container {name}: {err}"));
        let yaran = Yaran {
            container,
            _reaper: reaper,
            _own_network: own_network,
            logs,
            bind: options.bind,
            name,
        };
        if options.launch == Launch::Server {
            yaran.wait_healthy().await;
        }
        yaran
    }

    /// The container's name, for messages and for sidecars that join its
    /// network namespace.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The container's id.
    pub fn id(&self) -> &str {
        self.container.id()
    }

    /// The host port Docker published `container_port` on.
    ///
    /// # Panics
    ///
    /// When `container_port` is not published.
    pub async fn host_port(&self, container_port: u16) -> u16 {
        self.container
            .get_host_port_ipv4(container_port.tcp())
            .await
            .unwrap_or_else(|err| panic!("port {container_port} is not published: {err}"))
    }

    /// `http://127.0.0.1:<published>` for a container port.
    pub async fn url_on(&self, container_port: u16) -> String {
        format!("http://127.0.0.1:{}", self.host_port(container_port).await)
    }

    /// yaran's own URL from the host. Only meaningful for [`Bind::Everywhere`]; a
    /// local yaran is reached through a relay ([`Self::client_on`]).
    ///
    /// # Panics
    ///
    /// When this yaran is bound to loopback ([`Bind::Local`]), which has no URL from the host, or
    /// its port is not published.
    pub async fn url(&self) -> String {
        assert_eq!(
            self.bind,
            Bind::Everywhere,
            "a yaran bound to loopback has no URL from the host; use a relay port"
        );
        self.url_on(YARAN_PORT).await
    }

    /// A client on the network: a fresh cookie jar talking to yaran's published
    /// port.
    pub async fn client(&self) -> Client {
        Client::new(&self.url().await)
    }

    /// A fresh client through a published relay or sidecar port.
    pub async fn client_on(&self, container_port: u16) -> Client {
        Client::new(&self.url_on(container_port).await)
    }

    /// A client on THIS machine: curl inside the container against loopback,
    /// with a cookie jar of its own.
    pub fn inside(&self) -> Inside<'_> {
        Inside {
            yaran: self,
            jar: format!("/tmp/jar-{}", suffix()),
            base: format!("http://127.0.0.1:{YARAN_PORT}"),
            headers: Vec::new(),
        }
    }

    /// Run a shell script inside the container and collect what it did.
    ///
    /// # Panics
    ///
    /// When the exec cannot run (the container stopped), its output cannot be read, or it
    /// reports no exit code within 10 seconds of its output closing. The script itself runs
    /// unbounded: its output is read until it closes.
    pub async fn exec(&self, script: &str) -> Exec {
        let mut result = self
            .container
            .exec(ExecCommand::new([
                "sh",
                "-c",
                // The entrypoint exports YARAN_HOME for yaran and its seed hooks, but
                // an exec is a fresh shell: without it `yaran config set` would
                // find a different config than the running yaran reads.
                &format!("export YARAN_HOME={YARAN_HOME}; {script}"),
            ]))
            .await
            .unwrap_or_else(|err| {
                panic!(
                    "exec in {} failed; if the container stopped, a seed hook or yaran itself \
                     failed and its output is printed below: {err}",
                    self.name
                )
            });
        let stdout = result
            .stdout_to_vec()
            .await
            .unwrap_or_else(|err| panic!("read the exec's stdout in {}: {err}", self.name));
        let stderr = result
            .stderr_to_vec()
            .await
            .unwrap_or_else(|err| panic!("read the exec's stderr in {}: {err}", self.name));
        let code = eventually(
            "the exec to report its exit code",
            Duration::from_secs(10),
            || {
                let result = &result;
                async move { result.exit_code().await.ok().flatten() }
            },
        )
        .await;
        Exec {
            code,
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        }
    }

    /// [`Self::exec`], panicking with the output unless it exited 0.
    ///
    /// # Panics
    ///
    /// When the script cannot run or does not exit 0.
    pub async fn exec_ok(&self, script: &str) -> String {
        let run = self.exec(script).await;
        assert_eq!(
            run.code,
            0,
            "`{script}` failed in {}:\n{}",
            self.name,
            run.output()
        );
        run.stdout
    }

    /// `yaran config set <path> <value>`, as a person types it. Returns what it
    /// did rather than asserting, so a journey can check a refusal.
    pub async fn config_set(&self, path: &str, value: &str) -> Exec {
        self.exec(&format!(
            "yaran config set {} {}",
            shell_quote(path),
            shell_quote(value)
        ))
        .await
    }

    /// `yaran config set <path> --stdin` with `secret` piped in.
    pub async fn config_set_secret(&self, path: &str, secret: &str) -> Exec {
        self.exec(&secret_command(path, secret)).await
    }

    /// `yaran config get <path>`.
    pub async fn config_get(&self, path: &str) -> Exec {
        self.exec(&format!("yaran config get {}", shell_quote(path)))
            .await
    }

    /// The config file as it is on disk right now.
    pub async fn config_text(&self) -> String {
        self.exec_ok("cat \"$YARAN_HOME/config.toml\" 2>/dev/null || cat /data/yaran/config.toml")
            .await
    }

    /// Ask the running yaran to re-read its config, as `kill -USR1` does after a
    /// hand edit.
    pub async fn signal_reload(&self) {
        self.exec_ok("pkill -USR1 -x yaran").await;
    }

    /// Everything the container has printed so far (yaran's output and yaran.log).
    pub fn logs(&self) -> String {
        self.logs.text()
    }

    /// Wait until the container has printed `needle`.
    pub async fn wait_for_log(&self, needle: &str, within: Duration) {
        eventually(&format!("the log line {needle:?}"), within, || async {
            self.logs().contains(needle).then_some(())
        })
        .await;
    }

    /// Whether yaran answers `/healthz` from this machine right now.
    pub async fn answers_healthz(&self) -> bool {
        self.exec(&format!(
            "curl -fsS --max-time 2 http://127.0.0.1:{YARAN_PORT}/healthz"
        ))
        .await
        .code
            == 0
    }

    /// Wait until yaran answers `/healthz` from this machine.
    ///
    /// # Panics
    ///
    /// When the container stops before yaran answers, or yaran does not answer within 60 seconds.
    pub async fn wait_healthy(&self) {
        eventually(
            &format!("yaran in {} to answer /healthz", self.name),
            Duration::from_secs(60),
            || async {
                // A seed hook that failed (a `yaran config set` refusing, say)
                // ends the container; say that rather than timing out on it.
                assert!(
                    self.container.is_running().await.unwrap_or(false),
                    "the container {} stopped before yaran answered; a seed hook or yaran \
                     itself failed (its output is printed below)",
                    self.name
                );
                self.answers_healthz().await.then_some(())
            },
        )
        .await;
    }

    /// The process id of the running `yaran`, if one is running.
    pub async fn yaran_pid(&self) -> Option<u32> {
        let run = self.exec("pgrep -x yaran | head -1").await;
        run.stdout.trim().parse().ok()
    }

    /// Stop the yaran process inside the container and wait for the restart loop
    /// to bring up a new run that answers. Needs [`YaranOptions::with_restart_loop`].
    ///
    /// # Panics
    ///
    /// When yaran is not running, the stop fails, or no new yaran answers in time.
    pub async fn restart_process(&self) {
        let before = self.yaran_pid().await.expect("yaran is running");
        self.exec_ok(&format!("kill -TERM {before}")).await;
        eventually("a new yaran process", Duration::from_secs(30), || async {
            match self.yaran_pid().await {
                Some(pid) if pid != before => Some(()),
                _ => None,
            }
        })
        .await;
        self.wait_healthy().await;
    }

    /// Stop the yaran process, keep it down for `down`, then let the restart loop
    /// bring up a new run and wait until it answers. Needs
    /// [`YaranOptions::with_restart_loop`]; the loop holds while `/tmp/yaran-hold`
    /// exists.
    ///
    /// # Panics
    ///
    /// When yaran is not running, the stop fails, or no new yaran answers in time.
    pub async fn stop_process_for(&self, down: Duration) {
        let before = self.yaran_pid().await.expect("yaran is running");
        self.exec_ok(&format!("touch /tmp/yaran-hold && kill -TERM {before}"))
            .await;
        eventually(
            "the yaran process to exit",
            Duration::from_secs(30),
            || async { self.yaran_pid().await.is_none().then_some(()) },
        )
        .await;
        tokio::time::sleep(down).await;
        self.exec_ok("rm -f /tmp/yaran-hold").await;
        eventually("a new yaran process", Duration::from_secs(30), || async {
            self.yaran_pid().await.map(|_| ())
        })
        .await;
        self.wait_healthy().await;
    }

    /// Rewrite what the stand-in `tailscale serve status --json` answers. yaran
    /// reads it at its next look (every few seconds).
    pub async fn set_fake_serve(&self, json: &str) {
        let encoded = base64::engine::general_purpose::STANDARD.encode(json.as_bytes());
        self.exec_ok(&format!(
            "printf %s {} | base64 -d > /data/tailscale/serve.json.tmp && \
             mv /data/tailscale/serve.json.tmp /data/tailscale/serve.json",
            shell_quote(&encoded)
        ))
        .await;
    }

    /// The address yaran sees for a client on the host: the Docker bridge
    /// gateway, which is this container's default route.
    pub async fn host_client_address(&self) -> String {
        self.exec_ok("ip route show default | awk '{print $3; exit}'")
            .await
            .trim()
            .to_string()
    }

    /// The connections yaran has accepted on its port right now, as the kernel
    /// sees them: `(yaran's local address, the peer's address)`, ports dropped.
    /// This is the peer address yaran itself is handed for each connection, so a
    /// journey can prove which class of client it really was.
    pub async fn observed_peers(&self) -> Vec<(String, String)> {
        let listed = self
            .exec_ok(&format!(
                "ss -Htn state established '( sport = :{YARAN_PORT} )' | awk '{{print $3, $4}}'"
            ))
            .await;
        listed
            .lines()
            .filter_map(|line| {
                let (local, peer) = line.split_once(' ')?;
                Some((strip_port(local), strip_port(peer)))
            })
            .collect()
    }

    /// The addresses yaran is listening on, ports included (`127.0.0.1:3890`).
    pub async fn listening(&self) -> Vec<String> {
        self.exec_ok("ss -Htln | awk '{print $4}'")
            .await
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// The host's own `docker inspect` view of this container's published
    /// ports, for the test that nothing is published beyond loopback.
    pub async fn published_bindings(&self) -> Vec<(String, String, String)> {
        crate::container::published_bindings(self.id()).await
    }

    /// This container's address on its Docker network, for a browser or proxy
    /// container on the same network. An IP literal, because yaran's Host guard
    /// admits one for a wildcard bind and refuses a name nobody configured.
    pub async fn address(&self) -> String {
        self.exec_ok("ip -4 -o addr show dev eth0 | awk '{print $4}' | cut -d/ -f1 | head -1")
            .await
            .trim()
            .to_string()
    }

    /// Send keys to the terminal UI's tmux session (tmux key names: `C-p`,
    /// `Enter`, ...).
    pub async fn tmux_keys(&self, keys: &[&str]) {
        let keys: Vec<String> = keys.iter().map(|k| shell_quote(k)).collect();
        self.exec_ok(&format!(
            "tmux -L journey send-keys -t journey {}",
            keys.join(" ")
        ))
        .await;
    }

    /// Type literal text into the terminal UI.
    pub async fn tmux_type(&self, text: &str) {
        self.exec_ok(&format!(
            "tmux -L journey send-keys -t journey -l {}",
            shell_quote(text)
        ))
        .await;
    }

    /// The terminal UI's screen as text.
    pub async fn tmux_screen(&self) -> String {
        self.exec("tmux -L journey capture-pane -p -t journey")
            .await
            .stdout
    }

    /// Wait until the terminal UI shows `needle`.
    ///
    /// # Panics
    ///
    /// When the screen has not shown `needle` within `within`, printing the
    /// last screen it did show.
    pub async fn wait_for_screen(&self, needle: &str, within: Duration) {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let screen = self.tmux_screen().await;
            if screen.contains(needle) {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out after {within:?} waiting for the screen to show {needle:?}; \
                 it shows:\n{screen}"
            );
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
}

/// `1.2.3.4:5` or `[::1]:5` without its port, and an IPv4-mapped IPv6 address
/// as the IPv4 address it is.
fn strip_port(address: &str) -> String {
    let host = address
        .rsplit_once(':')
        .map_or(address, |(host, _)| host)
        .trim_start_matches('[')
        .trim_end_matches(']');
    host.trim_start_matches("::ffff:").to_string()
}

/// A client on this machine: `curl` inside the yaran container, against loopback,
/// with its own cookie jar file.
#[derive(Debug)]
pub struct Inside<'a> {
    yaran: &'a Yaran,
    jar: String,
    base: String,
    headers: Vec<(String, String)>,
}

impl Inside<'_> {
    /// Send this header on every request from now on.
    #[must_use]
    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    /// Talk to another loopback port inside the container (a sidecar's).
    #[must_use]
    pub fn on_port(mut self, port: u16) -> Self {
        self.base = format!("http://127.0.0.1:{port}");
        self
    }

    /// `GET path`, as [`Self::request`] sends it.
    ///
    /// # Panics
    ///
    /// As [`Self::request`] does.
    pub async fn get(&self, path: &str) -> Response {
        self.request("GET", path, None).await
    }

    /// `POST path` with `body` as JSON, as [`Self::request`] sends it.
    ///
    /// # Panics
    ///
    /// As [`Self::request`] does.
    pub async fn post_json(&self, path: &str, body: &serde_json::Value) -> Response {
        self.request("POST", path, Some(body)).await
    }

    /// `POST path` with no body, as [`Self::request`] sends it.
    ///
    /// # Panics
    ///
    /// As [`Self::request`] does.
    pub async fn post_empty(&self, path: &str) -> Response {
        self.request("POST", path, None).await
    }

    /// `POST /api/v1/auth/login` with `password`.
    pub async fn login(&self, password: &str) -> Response {
        self.post_json(
            "/api/v1/auth/login",
            &serde_json::json!({ "password": password }),
        )
        .await
    }

    /// `GET /api/v1/auth/status` as JSON.
    ///
    /// # Panics
    ///
    /// When curl fails, or the status does not answer 200 with JSON.
    pub async fn auth_status(&self) -> serde_json::Value {
        let response = self.get("/api/v1/auth/status").await;
        assert_eq!(
            response.status,
            200,
            "auth status is public and always answers: {}",
            response.describe()
        );
        response.json()
    }

    /// One request, made the way a browser on this machine would: the jar,
    /// and an `Origin` naming yaran itself on anything but a GET.
    ///
    /// # Panics
    ///
    /// When curl fails inside the container or prints no HTTP status line.
    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Response {
        let mut command = format!(
            "curl -sS -i --http1.1 --max-time 30 -c {jar} -b {jar} -X {method}",
            jar = shell_quote(&self.jar),
        );
        if method != "GET" {
            let _ = write!(
                command,
                " -H {}",
                shell_quote(&format!("Origin: {}", self.base))
            );
        }
        for (name, value) in &self.headers {
            let _ = write!(command, " -H {}", shell_quote(&format!("{name}: {value}")));
        }
        let script = match body {
            Some(body) => {
                let encoded =
                    base64::engine::general_purpose::STANDARD.encode(body.to_string().as_bytes());
                format!(
                    "printf %s {} | base64 -d | {command} -H 'Content-Type: application/json' \
                     --data-binary @- {}",
                    shell_quote(&encoded),
                    shell_quote(&format!("{}{path}", self.base))
                )
            }
            None => format!("{command} {}", shell_quote(&format!("{}{path}", self.base))),
        };
        let run = self.yaran.exec(&script).await;
        assert_eq!(
            run.code,
            0,
            "curl {method} {path} from inside failed: {}",
            run.output()
        );
        parse_raw_response(&run.stdout)
    }
}
