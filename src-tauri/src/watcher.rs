use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Mutex,
};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, State};

use crate::models::WatchFolderEvent;

#[derive(Default)]
pub struct FolderWatcherState {
    watcher: Mutex<Option<RecommendedWatcher>>,
}

#[tauri::command]
pub fn start_folder_watch(
    app: AppHandle,
    state: State<'_, FolderWatcherState>,
    folders: Vec<String>,
) -> Result<(), String> {
    let canonical_folders = canonical_watch_folders(&folders)?;
    if canonical_folders.is_empty() {
        return Err("Choose at least one valid folder to watch".to_string());
    }
    let app_handle = app.clone();
    let event_folders = canonical_folders.clone();
    let mut watcher = RecommendedWatcher::new(
        move |event: notify::Result<Event>| {
            if let Ok(event) = event {
                if is_relevant_event(&event.kind) {
                    for folder in changed_folders(&event, &event_folders) {
                        let _ =
                            app_handle.emit("watch-folder-changed", WatchFolderEvent { folder });
                    }
                }
            }
        },
        Config::default(),
    )
    .map_err(|error| format!("Could not create folder watcher: {error}"))?;

    for folder in &canonical_folders {
        watcher
            .watch(folder, RecursiveMode::NonRecursive)
            .map_err(|error| format!("Could not watch folder: {error}"))?;
    }

    let mut guard = state
        .watcher
        .lock()
        .map_err(|_| "Could not lock folder watcher".to_string())?;
    *guard = Some(watcher);
    Ok(())
}

#[tauri::command]
pub fn stop_folder_watch(state: State<'_, FolderWatcherState>) -> Result<(), String> {
    let mut guard = state
        .watcher
        .lock()
        .map_err(|_| "Could not lock folder watcher".to_string())?;
    *guard = None;
    Ok(())
}

fn is_relevant_event(kind: &EventKind) -> bool {
    matches!(kind, EventKind::Create(_) | EventKind::Modify(_))
}

fn changed_folders(event: &Event, folders: &[PathBuf]) -> Vec<String> {
    let mut changed = BTreeSet::new();
    for path in &event.paths {
        if !is_supported_path(path) {
            continue;
        }
        if let Some(parent) = path.parent().and_then(|parent| parent.canonicalize().ok()) {
            if folders.iter().any(|folder| folder == &parent) {
                changed.insert(parent.to_string_lossy().to_string());
            }
        }
    }
    changed.into_iter().collect()
}

fn canonical_watch_folders(folders: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut unique = BTreeSet::new();
    for folder in folders {
        let path = PathBuf::from(folder);
        if !path.is_dir() {
            return Err("Choose a valid folder to watch".to_string());
        }
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("Could not resolve watched folder: {error}"))?;
        unique.insert(canonical);
    }
    Ok(unique.into_iter().collect())
}

fn is_supported_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png" | "webp"
            )
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use notify::{event::CreateKind, Event};

    use super::*;

    #[test]
    fn canonical_watch_folders_deduplicates_paths() {
        let temp = tempfile::tempdir().unwrap();
        let folders = vec![
            temp.path().to_string_lossy().to_string(),
            temp.path().join(".").to_string_lossy().to_string(),
        ];

        let canonical = canonical_watch_folders(&folders).unwrap();

        assert_eq!(canonical.len(), 1);
    }

    #[test]
    fn changed_folders_only_reports_supported_current_level_images() {
        let temp = tempfile::tempdir().unwrap();
        let nested = temp.path().join("nested");
        std::fs::create_dir(&nested).unwrap();
        let event = Event {
            kind: EventKind::Create(CreateKind::File),
            paths: vec![
                temp.path().join("photo.webp"),
                temp.path().join("clip.avif"),
                nested.join("child.png"),
            ],
            attrs: Default::default(),
        };
        let folders = vec![temp.path().canonicalize().unwrap()];

        let changed = changed_folders(&event, &folders);

        assert_eq!(
            changed,
            vec![temp.path().canonicalize().unwrap().to_string_lossy()]
        );
    }
}
