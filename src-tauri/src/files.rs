use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
};

use walkdir::WalkDir;

use crate::{
    metadata::{finalize_output_bytes, is_marked_compressed_path},
    models::{CompressOptions, ImageFile, OutputPolicy},
};

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "avif"];

pub fn scan_image_paths(paths: Vec<String>) -> Result<Vec<ImageFile>, FileError> {
    let mut files = BTreeMap::new();

    for input in paths {
        let path = PathBuf::from(input);
        if path.is_file() {
            add_image(&path, &mut files)?;
        } else if path.is_dir() {
            for entry in WalkDir::new(&path)
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
            {
                if entry.file_type().is_file() {
                    add_image(entry.path(), &mut files)?;
                }
            }
        }
    }

    Ok(files.into_values().collect())
}

pub fn write_output_file(
    source_path: &str,
    bytes: &[u8],
    extension: &str,
    output_policy: &OutputPolicy,
    custom_output_dir: Option<String>,
    options: &CompressOptions,
) -> Result<String, FileError> {
    let source = PathBuf::from(source_path);
    let target = output_path(&source, extension, output_policy, custom_output_dir)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let final_bytes = finalize_output_bytes(&source, bytes, &target, options)?;
    fs::write(&target, final_bytes)?;
    Ok(target.to_string_lossy().to_string())
}

fn add_image(path: &Path, files: &mut BTreeMap<String, ImageFile>) -> Result<(), FileError> {
    if !is_supported_image(path) {
        return Ok(());
    }

    let metadata = fs::metadata(path)?;
    let canonical = fs::canonicalize(path)?;
    let extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();

    files.insert(
        canonical.to_string_lossy().to_string(),
        ImageFile {
            path: canonical.to_string_lossy().to_string(),
            name,
            extension,
            size: metadata.len(),
            is_compressed: is_marked_compressed_path(&canonical)?,
        },
    );
    Ok(())
}

fn is_supported_image(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|ext| IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn output_path(
    source: &Path,
    extension: &str,
    output_policy: &OutputPolicy,
    custom_output_dir: Option<String>,
) -> Result<PathBuf, FileError> {
    let file_stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or(FileError::InvalidSourcePath)?;
    let source_extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or(extension);
    let output_extension = if extension == "same" || extension.is_empty() {
        source_extension
    } else {
        extension
    };

    let file_name = format!("{file_stem}.{output_extension}");
    match output_policy {
        OutputPolicy::Overwrite => Ok(source.with_file_name(file_name)),
        OutputPolicy::Subdirectory => {
            let parent = source.parent().ok_or(FileError::InvalidSourcePath)?;
            Ok(parent.join("compressed").join(file_name))
        }
        OutputPolicy::CustomDirectory => {
            let dir = custom_output_dir
                .map(PathBuf::from)
                .ok_or(FileError::MissingCustomOutputDirectory)?;
            Ok(dir.join(file_name))
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum FileError {
    #[error("File system error: {0}")]
    Io(#[from] io::Error),
    #[error("Invalid source image path")]
    InvalidSourcePath,
    #[error("Choose a custom output directory first")]
    MissingCustomOutputDirectory,
    #[error("Invalid PNG metadata")]
    InvalidPng,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_supported_extensions() {
        assert!(is_supported_image(Path::new("a.JPG")));
        assert!(is_supported_image(Path::new("a.webp")));
        assert!(!is_supported_image(Path::new("a.gif")));
    }

    #[test]
    fn writes_to_compressed_subdirectory_by_default() {
        let path = output_path(
            Path::new("/tmp/photo.png"),
            "webp",
            &OutputPolicy::Subdirectory,
            None,
        )
        .unwrap();
        assert_eq!(path, PathBuf::from("/tmp/compressed/photo.webp"));
    }
}
