//! Alpha crate root.
pub mod flat;
pub mod nested;
mod dirmod;
#[path = "custom/place.rs"]
mod placed;
mod inline {
    #[path = "inner_target.rs"]
    mod inner;
}
use serde::Serialize;

pub struct Root;
