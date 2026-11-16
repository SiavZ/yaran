//! Non-mod-rs file with #[path] inside an inline block, and a glob import.
mod blk {
    #[path = "deep.rs"]
    mod deep;
}
use crate::dirmod::*;
