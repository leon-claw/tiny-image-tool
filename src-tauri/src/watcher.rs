use std::{
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
    folder: String,
) -> Result<(), String> {
    let path = PathBuf::from(&folder);
    if !path.is_dir() {
        return Err("Choose a valid folder to watch".to_string());
    }

    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Could not resolve watched folder: {error}"))?;
    let payload_folder = canonical.to_string_lossy().to_string();
    let app_handle = app.clone();
    let mut watcher = RecommendedWatcher::new(
        move |event: notify::Result<Event>| {
            if let Ok(event) = event {
                if is_relevant_event(&event.kind)
                    && event.paths.iter().any(|path| is_supported_path(path))
                {
                    let _ = app_handle.emit(
                        "watch-folder-changed",
                        WatchFolderEvent {
                            folder: payload_folder.clone(),
                        },
                    );
                }
            }
        },
        Config::default(),
    )
    .map_err(|error| format!("Could not create folder watcher: {error}"))?;

    watcher
        .watch(&canonical, RecursiveMode::NonRecursive)
        .map_err(|error| format!("Could not watch folder: {error}"))?;

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

fn is_supported_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png" | "webp" | "avif"
            )
        })
        .unwrap_or(false)
}
