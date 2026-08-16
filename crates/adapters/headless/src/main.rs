//! Binary entry for the Headless host. All behaviour lives in the library
//! so argument parsing is unit-tested without spawning the process.

fn main() {
    std::process::exit(i32::from(neotavern_headless::run(std::env::args())));
}
