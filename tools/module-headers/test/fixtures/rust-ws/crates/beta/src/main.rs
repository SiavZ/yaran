//! Beta binary: cross-crate uses.
use alpha_core::flat::child;
use std::fs;

fn main() {
    child::f();
    alpha_core::nested::thing();
}
