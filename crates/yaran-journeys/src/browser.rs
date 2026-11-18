//! A real browser for the journeys that are about what a person SEES: headless
//! Chromium driven over `WebDriver` by `chromedriver`, both from the journey image
//! (Arch's chromium package ships the driver), in a container of its own.
//!
//! Where the browser sits decides who yaran thinks it is:
//!
//! - [`Browser::on_network`] puts it on a journey network beside yaran, a separate
//!   machine as far as yaran can tell: a client from the network.
//! - [`Browser::beside`] puts it in yaran's own network namespace, so it reaches
//!   yaran on loopback: this machine. yaran must publish [`WEBDRIVER_PORT`] for it.
//!
//! chromedriver takes commands from exactly one address: the Docker gateway its
//! container sees, which is where the host's connection through the published
//! port arrives from. That port is published on the host's loopback only (see
//! [`crate::container`]), so nothing beyond this machine can reach the driver.

use std::time::Duration;

use crate::container::{Container, ContainerRequest, Ready};
use crate::image::{JourneyNetwork, journey_image};
use crate::util::eventually;
use crate::yaran::Yaran;
use fantoccini::{Client as WebDriver, ClientBuilder, Locator};
use hyper_util::client::legacy::connect::HttpConnector;

/// The port chromedriver listens on inside its container.
pub const WEBDRIVER_PORT: u16 = 4444;

/// One browser. The container is removed when dropped (call [`Browser::quit`]
/// first for a clean session end).
#[derive(Debug)]
pub struct Browser {
    driver: WebDriver,
    container: Container,
}

/// How long chromedriver may take to say it started.
const STARTUP: Duration = Duration::from_secs(60);

/// The browser container every placement shares: the journey image running
/// chromedriver, with the shared memory Chromium needs.
async fn request() -> ContainerRequest {
    ContainerRequest::new("browser", journey_image().await)
        .arg("--entrypoint", "/usr/bin/env")
        .arg("--shm-size", (512 * 1024 * 1024).to_string())
        .cmd(chromedriver_command())
}

/// Start `request`, ready once chromedriver says so.
async fn start(request: ContainerRequest) -> Container {
    request
        .start(Ready::Log("ChromeDriver was started successfully"), STARTUP)
        .await
        .unwrap_or_else(|err| panic!("start the browser container: {err}"))
}

/// chromedriver, allowing commands only from the container's default gateway.
fn chromedriver_command() -> Vec<String> {
    vec![
        "sh".to_string(),
        "-c".to_string(),
        format!(
            "gateway=$(ip route show default | awk '{{print $3; exit}}') && \
             exec chromedriver --port={WEBDRIVER_PORT} --allowed-ips=\"$gateway\""
        ),
    ]
}

impl Browser {
    /// A browser on `network`, which yaran must also be on.
    ///
    /// # Panics
    ///
    /// When the container does not start, its `WebDriver` port is not published, or no
    /// `WebDriver` session opens within 30 seconds.
    pub async fn on_network(network: &JourneyNetwork) -> Browser {
        let container = start(
            request()
                .await
                .publish_loopback(&[WEBDRIVER_PORT])
                .arg("--network", network.name()),
        )
        .await;
        let port = container
            .host_port(WEBDRIVER_PORT)
            .await
            .expect("the WebDriver port is published");
        let driver = connect(port).await;
        Browser { driver, container }
    }

    /// A browser in `yaran`'s own network namespace (this machine). `yaran` must
    /// have been started with `with_published(WEBDRIVER_PORT)`.
    ///
    /// # Panics
    ///
    /// When the container does not start, `yaran` does not publish [`WEBDRIVER_PORT`], or no
    /// `WebDriver` session opens within 30 seconds.
    pub async fn beside(yaran: &Yaran) -> Browser {
        let container = start(request().await.share_namespace_of(yaran.id())).await;
        let port = yaran.host_port(WEBDRIVER_PORT).await;
        let driver = connect(port).await;
        Browser { driver, container }
    }

    /// The browser container's id, for inspecting what it publishes.
    pub fn container_id(&self) -> &str {
        self.container.id()
    }

    /// Go to `url` and wait for the document to finish loading.
    ///
    /// # Panics
    ///
    /// When the browser cannot load `url`.
    pub async fn goto(&self, url: &str) {
        self.driver
            .goto(url)
            .await
            .unwrap_or_else(|err| panic!("navigate to {url}: {err}"));
    }

    /// Wait until an element matching `css` exists, or panic naming `what`.
    ///
    /// # Panics
    ///
    /// When no element matches `css` within 20 seconds.
    pub async fn wait_for(&self, css: &str, what: &str) -> fantoccini::elements::Element {
        self.driver
            .wait()
            .at_most(Duration::from_secs(20))
            .for_element(Locator::Css(css))
            .await
            .unwrap_or_else(|err| panic!("{what} ({css}) never appeared: {err}"))
    }

    /// Whether an element matching `css` exists and is displayed right now.
    pub async fn is_shown(&self, css: &str) -> bool {
        match self.driver.find(Locator::Css(css)).await {
            Ok(element) => element.is_displayed().await.unwrap_or(false),
            Err(_) => false,
        }
    }

    /// Wait until no displayed element matches `css`.
    pub async fn wait_gone(&self, css: &str, what: &str) {
        eventually(what, Duration::from_secs(20), || async {
            (!self.is_shown(css).await).then_some(())
        })
        .await;
    }

    /// The page's current URL.
    ///
    /// # Panics
    ///
    /// When the browser cannot say which URL it is on.
    pub async fn url(&self) -> String {
        self.driver
            .current_url()
            .await
            .expect("the current URL")
            .to_string()
    }

    /// The visible text of the whole page.
    pub async fn page_text(&self) -> String {
        match self.driver.find(Locator::Css("body")).await {
            Ok(body) => body.text().await.unwrap_or_default(),
            Err(_) => String::new(),
        }
    }

    /// End the `WebDriver` session.
    pub async fn quit(self) {
        let _ = self.driver.clone().close().await;
    }
}

async fn connect(port: u16) -> WebDriver {
    let mut capabilities = serde_json::Map::new();
    capabilities.insert(
        "goog:chromeOptions".to_string(),
        serde_json::json!({
            "args": [
                "--headless=new",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--window-size=1440,900",
            ]
        }),
    );
    let url = format!("http://127.0.0.1:{port}");
    eventually("a WebDriver session", Duration::from_secs(30), || {
        let capabilities = capabilities.clone();
        let url = url.clone();
        async move {
            ClientBuilder::new(HttpConnector::new())
                .capabilities(capabilities)
                .connect(&url)
                .await
                .ok()
        }
    })
    .await
}
