const COMMANDS: &[&str] = &[
    "get_snapshot",
    "get_item",
    "search_items",
    "update_item",
    "purge_item",
    "create_collection",
    "update_settings",
    "copy_item",
    "get_image",
    "get_thumbnail",
    "paste_item",
    "open_link",
    "hide_quick_window",
];
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("Tauri manifest and command ACL generation failed");
}
