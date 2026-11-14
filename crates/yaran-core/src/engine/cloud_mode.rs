//! `Engine::set_cloud_mode`: the config write behind the `set-cloud-mode` palette
//! command and the web Preferences row.
//!
//! The write only. Moving the tunnel is the serve loop's job (the `CloudModeControl`
//! lane), because only the serve loop owns the leg; the engine has no idea whether
//! anything is serving. An unrecognized value is refused, never degraded.
//!
//! - Lazy save, like the sibling preferences: the serve has already acted by the time
//!   the file lands.
//!
//! <module-headers:begin>
//! Uses:
//! engine/cloud_mode.rs
//! └── cloud::leg_seam
//! External: anyhow
//!
//! Used by:
//! engine/cloud_mode.rs
//! └── engine
//! <module-headers:end>

use super::Engine;
use crate::cloud::leg_seam::{self, CloudMode};

impl Engine {
    /// Save `[cloud] mode`, refusing anything outside the tri-state.
    pub fn set_cloud_mode(&mut self, mode: &str) -> anyhow::Result<CloudMode> {
        let parsed = parse_mode(mode)?;
        if leg_seam::settings_from_config(&self.config).mode != parsed {
            if !leg_seam::store_mode(&mut self.config, parsed) {
                anyhow::bail!(
                    "This build has no [cloud] section yet, so [cloud] mode cannot be saved as \"{}\".",
                    parsed.as_str()
                );
            }
            self.config_writer.save_lazy(self.config.clone());
        }
        Ok(parsed)
    }
}

fn parse_mode(mode: &str) -> anyhow::Result<CloudMode> {
    CloudMode::parse(mode).ok_or_else(|| {
        anyhow::anyhow!("Unknown cloud mode \"{mode}\". Expected one of: auto, yes, no.")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mode_is_parsed_and_anything_else_refused() {
        assert_eq!(parse_mode(" Yes ").unwrap(), CloudMode::Yes);
        let err = parse_mode("sometimes").unwrap_err().to_string();
        assert!(err.contains("auto, yes, no"), "{err}");
    }

    #[test]
    fn saving_the_current_mode_is_a_no_op() {
        let (mut engine, _tmp) = crate::engine::test_support::test_engine();
        let current = leg_seam::settings_from_config(&engine.config).mode;
        assert_eq!(engine.set_cloud_mode(current.as_str()).unwrap(), current);
        assert!(engine.set_cloud_mode("banana").is_err());
    }
}
