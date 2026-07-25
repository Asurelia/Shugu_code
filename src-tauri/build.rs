fn main() {
    tauri_build::build();

    // `tauri-build` embeds the Common Controls v6 manifest in application
    // binaries only. The library test executable links `TaskDialogIndirect`
    // through tauri-plugin-dialog too, so it needs the same resource or Windows
    // loads comctl32 v5 and aborts before the first Rust test can run.
    #[cfg(target_os = "windows")]
    {
        let resource = std::path::PathBuf::from(
            std::env::var_os("OUT_DIR").expect("OUT_DIR is set for build scripts"),
        )
        .join("resource.lib");
        println!(
            "cargo:rustc-link-search=native={}",
            resource
                .parent()
                .expect("resource.lib is generated inside OUT_DIR")
                .display()
        );
    }
}
