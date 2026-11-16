//! A mod.rs module.
mod leaf;
pub fn call() {
    crate::flat::child::f();
    let _r: crate::Root = crate::Root;
    std::process::exit(0);
}
