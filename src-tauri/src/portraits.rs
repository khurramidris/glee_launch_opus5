//! Keeps a private copy of every portrait so a character or profile keeps its
//! picture after the original image is moved, renamed, or deleted.

use std::{
    fs,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

const PORTRAIT_DIR: &str = "portraits";
const MAX_PORTRAIT_BYTES: u64 = 20 * 1024 * 1024;
const PORTRAIT_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];

pub fn portrait_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(PORTRAIT_DIR)
}

/// Returns the path that should be stored for `source`.
///
/// Image files outside the portrait folder are copied into it, named after
/// their content, so the same picture is stored once. Anything else (an empty
/// value, a data URL, a missing or oversized file) is returned unchanged:
/// saving a character must never fail because of its picture.
pub fn persist_portrait(app_data_dir: &Path, source: &str) -> String {
    let source = source.trim();
    if source.is_empty() || source.starts_with("data:") {
        return source.to_string();
    }
    let source_path = Path::new(source);
    let dir = portrait_dir(app_data_dir);
    if source_path.starts_with(&dir) {
        return source.to_string();
    }
    match copy_into(&dir, source_path) {
        Ok(Some(stored)) => stored.to_string_lossy().to_string(),
        Ok(None) => source.to_string(),
        Err(error) => {
            eprintln!("could not keep a copy of portrait {source}: {error}");
            source.to_string()
        }
    }
}

fn copy_into(dir: &Path, source: &Path) -> std::io::Result<Option<PathBuf>> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !PORTRAIT_EXTENSIONS.contains(&extension.as_str()) {
        return Ok(None);
    }
    let metadata = match fs::metadata(source) {
        Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_PORTRAIT_BYTES => metadata,
        _ => return Ok(None),
    };
    let bytes = fs::read(source)?;
    debug_assert_eq!(bytes.len() as u64, metadata.len());
    let digest = Sha256::digest(&bytes);
    let name = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let target = dir.join(format!("{name}.{extension}"));
    if !target.exists() {
        fs::create_dir_all(dir)?;
        fs::write(&target, &bytes)?;
    }
    Ok(Some(target))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("glee-portraits-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn copies_images_into_the_app_folder_once() {
        let root = scratch_dir();
        let app_data = root.join("app");
        let original = root.join("me.PNG");
        fs::write(&original, b"not really a png").unwrap();

        let stored = persist_portrait(&app_data, original.to_str().unwrap());
        assert!(Path::new(&stored).starts_with(portrait_dir(&app_data)));
        assert_eq!(fs::read(&stored).unwrap(), b"not really a png");

        fs::remove_file(&original).unwrap();
        assert!(Path::new(&stored).is_file(), "copy survives the original");
        assert_eq!(persist_portrait(&app_data, &stored), stored);

        let twin = root.join("copy-of-me.png");
        fs::write(&twin, b"not really a png").unwrap();
        assert_eq!(persist_portrait(&app_data, twin.to_str().unwrap()), stored);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn leaves_unusable_values_alone() {
        let root = scratch_dir();
        let app_data = root.join("app");
        assert_eq!(persist_portrait(&app_data, "  "), "");
        assert_eq!(
            persist_portrait(&app_data, "data:image/png;base64,AAAA"),
            "data:image/png;base64,AAAA"
        );
        assert_eq!(
            persist_portrait(&app_data, "/no/such/file.png"),
            "/no/such/file.png"
        );
        let text = root.join("notes.txt");
        fs::write(&text, b"hello").unwrap();
        let text = text.to_str().unwrap().to_string();
        assert_eq!(persist_portrait(&app_data, &text), text);
        let _ = fs::remove_dir_all(root);
    }
}
