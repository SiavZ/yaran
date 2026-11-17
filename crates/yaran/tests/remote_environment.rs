//! Remote environment aliases are checked through isolated CLI processes, so
//! neither the developer's config nor other tests' environments are changed.

use std::process::Command;

#[test]
fn remote_selection_preserves_legacy_fallback_and_explicit_empty_override() {
    for (current, exit, selected) in [
        (None, 2, Some("legacy-box")),
        (Some("new-box"), 2, Some("new-box")),
        (Some(""), 4, None),
    ] {
        let home = tempfile::tempdir().unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_yaran"));
        command
            .args(["agents", "ls"])
            .env("YARAN_HOME", home.path())
            .env("DUX_REMOTE", "legacy-box")
            .env_remove("YARAN_REMOTE");
        if let Some(current) = current {
            command.env("YARAN_REMOTE", current);
        }
        let output = command.output().unwrap();
        let error = String::from_utf8(output.stderr).unwrap();
        assert_eq!(output.status.code(), Some(exit), "{current:?}: {error}");
        if let Some(selected) = selected {
            assert!(
                error.contains(&format!("no remote is saved as {selected}")),
                "{current:?}: {error}"
            );
        } else {
            assert!(!error.contains("legacy-box"), "{error}");
        }
    }
}
