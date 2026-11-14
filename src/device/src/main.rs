//! Binary entry point for the Work device Broker. Batch 0 only prints the
//! version; the named-pipe service loop lands with the IPC batch.

fn main() {
    println!("work-device broker {}", work_device::version());
}
