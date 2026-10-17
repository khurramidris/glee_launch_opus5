// Keep the desktop app out of a console host on Windows for both debug and release runs.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    glee_desktop_lib::run()
}
