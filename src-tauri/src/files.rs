use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
};

use walkdir::WalkDir;

use crate::{
    metadata::{finalize_output_bytes, is_marked_compressed_path},
    models::{CompressOptions, ImageFile, OutputPolicy, WatchFolderScan},
};

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp"];

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

pub fn scan_image_folder(folder: String, recursive: bool) -> Result<Vec<ImageFile>, FileError> {
    let path = PathBuf::from(folder);
    if !path.is_dir() {
        return Err(FileError::InvalidSourcePath);
    }

    let mut files = BTreeMap::new();
    if recursive {
        for entry in WalkDir::new(&path)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if entry.file_type().is_file() {
                add_image(entry.path(), &mut files)?;
            }
        }
    } else {
        for entry in fs::read_dir(&path)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                add_image(&entry.path(), &mut files)?;
            }
        }
    }

    Ok(files.into_values().collect())
}

pub fn scan_watch_folder(folder: String) -> Result<WatchFolderScan, FileError> {
    let path = PathBuf::from(&folder);
    if !path.is_dir() {
        return Err(FileError::InvalidSourcePath);
    }

    let canonical_folder = fs::canonicalize(&path)?;
    let mut all_files = 0;
    let mut files = BTreeMap::new();

    for entry in fs::read_dir(&canonical_folder)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            all_files += 1;
            add_image(&entry.path(), &mut files)?;
        }
    }

    let image_files = files.into_values().collect::<Vec<_>>();
    let compressed_files = image_files.iter().filter(|file| file.is_compressed).count();
    let supported_files = image_files.len();

    Ok(WatchFolderScan {
        folder: canonical_folder.to_string_lossy().to_string(),
        all_files,
        supported_files,
        compressed_files,
        uncompressed_files: supported_files.saturating_sub(compressed_files),
        files: image_files,
    })
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
            is_compressed: is_marked_compressed_path(&canonical)?
                || has_marked_output_in_compressed_folder(&canonical)?,
        },
    );
    Ok(())
}

fn has_marked_output_in_compressed_folder(source: &Path) -> Result<bool, FileError> {
    if source
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
        .map(|name| name == "compressed")
        .unwrap_or(false)
    {
        return Ok(false);
    }

    let Some(parent) = source.parent() else {
        return Ok(false);
    };
    let Some(stem) = source.file_stem().and_then(|value| value.to_str()) else {
        return Ok(false);
    };
    let compressed_dir = parent.join("compressed");
    if !compressed_dir.is_dir() {
        return Ok(false);
    }

    for extension in IMAGE_EXTENSIONS {
        let candidate = compressed_dir.join(format!("{stem}.{extension}"));
        if candidate.is_file() && is_marked_compressed_path(&candidate)? {
            return Ok(true);
        }
    }
    Ok(false)
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
        assert!(!is_supported_image(Path::new("a.avif")));
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

    #[test]
    fn scans_current_folder_without_recursing() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("root.jpg"), [0xff, 0xd8, 0xff, 0xd9]).unwrap();
        fs::create_dir(temp.path().join("nested")).unwrap();
        fs::write(
            temp.path().join("nested").join("child.jpg"),
            [0xff, 0xd8, 0xff, 0xd9],
        )
        .unwrap();

        let files = scan_image_folder(temp.path().to_string_lossy().to_string(), false).unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "root.jpg");
    }

    #[test]
    fn scans_watch_folder_counts_current_level_images() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("fresh.jpg"), [0xff, 0xd8, 0xff, 0xd9]).unwrap();
        fs::write(temp.path().join("image.avif"), b"not supported").unwrap();
        fs::write(temp.path().join("notes.txt"), b"hello").unwrap();
        fs::create_dir(temp.path().join("nested")).unwrap();
        fs::write(
            temp.path().join("nested").join("child.png"),
            [137, 80, 78, 71, 13, 10, 26, 10],
        )
        .unwrap();

        let scan = scan_watch_folder(temp.path().to_string_lossy().to_string()).unwrap();

        assert_eq!(scan.all_files, 3);
        assert_eq!(scan.supported_files, 1);
        assert_eq!(scan.compressed_files, 0);
        assert_eq!(scan.uncompressed_files, 1);
        assert_eq!(scan.files[0].name, "fresh.jpg");
    }

    #[test]
    fn treats_source_as_compressed_when_marked_output_exists_in_compressed_folder() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("photo.jpg");
        fs::write(&source, [0xff, 0xd8, 0xff, 0xd9]).unwrap();
        write_output_file(
            &source.to_string_lossy(),
            &[0xff, 0xd8, 0xff, 0xd9],
            "same",
            &OutputPolicy::Subdirectory,
            None,
            &CompressOptions {
                quality: 80,
                format: "same".to_string(),
                max_width: None,
                max_height: None,
                preserve_metadata: false,
                preserve_comfy_workflow: true,
            },
        )
        .unwrap();

        let scan = scan_watch_folder(temp.path().to_string_lossy().to_string()).unwrap();

        assert_eq!(scan.supported_files, 1);
        assert_eq!(scan.compressed_files, 1);
        assert_eq!(scan.uncompressed_files, 0);
        assert!(scan.files[0].is_compressed);
    }
}
