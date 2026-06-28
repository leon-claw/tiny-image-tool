use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    io,
    path::{Path, PathBuf},
};

use crate::models::{
    mask_secret, ApiKeyEntry, AppConfig, Provider, UsageResult, WatchFolderConfig,
};

pub fn load_app_config() -> Result<AppConfig, ConfigError> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(AppConfig::default().masked());
    }

    let raw = fs::read_to_string(&path)?;
    let config = serde_json::from_str::<AppConfig>(&raw)?;
    Ok(normalize_app_config(config).masked())
}

pub fn load_raw_config() -> Result<AppConfig, ConfigError> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }

    let raw = fs::read_to_string(&path)?;
    Ok(normalize_app_config(serde_json::from_str::<AppConfig>(
        &raw,
    )?))
}

pub fn save_app_config(config: &AppConfig) -> Result<(), ConfigError> {
    let existing = load_raw_config().unwrap_or_default();
    let mut incoming = config.clone();
    clear_deleted_masked_legacy_fields(&mut incoming);
    let mut next = normalize_app_config(incoming);
    merge_preserved_keys(&mut next.compresto_keys, &existing.compresto_keys);
    merge_preserved_keys(&mut next.tinify_keys, &existing.tinify_keys);
    next = normalize_app_config(next);
    ensure_unique_keys(Provider::Compresto, &next.compresto_keys)?;
    ensure_unique_keys(Provider::Tinify, &next.tinify_keys)?;
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let body = serde_json::to_string_pretty(&next)?;
    fs::write(path, body)?;
    Ok(())
}

pub fn update_tinify_usage_for_key(
    key_id: Option<&str>,
    count: u32,
    checked_at: String,
) -> Result<(), ConfigError> {
    let mut config = load_raw_config().unwrap_or_default();
    config.tinify_compression_count = Some(count);
    config.tinify_last_checked_at = Some(checked_at);
    update_key_usage_fields(
        &mut config,
        Provider::Tinify,
        key_id,
        Some(count),
        None,
        None,
    );
    save_exact_config(&config)
}

pub fn update_usage_for_key(
    provider: Provider,
    key_id: Option<&str>,
    usage: &UsageResult,
) -> Result<(), ConfigError> {
    let mut config = load_raw_config().unwrap_or_default();
    update_key_usage_fields(
        &mut config,
        provider,
        key_id,
        usage.used,
        usage.limit,
        usage.remaining,
    );
    match provider {
        Provider::Compresto => {}
        Provider::Tinify => {
            config.tinify_compression_count = usage.used;
            config.tinify_last_checked_at = Some(usage.last_checked_at.clone());
        }
    }
    save_exact_config(&config)
}

pub fn mark_api_key_quota_exhausted(
    provider: Provider,
    key_id: Option<&str>,
) -> Result<(), ConfigError> {
    let mut config = load_raw_config().unwrap_or_default();
    update_key_quota_exhausted(&mut config, provider, key_id);
    save_exact_config(&config)
}

fn update_key_quota_exhausted(config: &mut AppConfig, provider: Provider, key_id: Option<&str>) {
    let normalized = normalize_app_config(config.clone());
    *config = normalized;
    let checked_at = chrono::Utc::now().to_rfc3339();
    let (entries, active_id) = match provider {
        Provider::Compresto => (
            &mut config.compresto_keys,
            config.active_compresto_key_id.clone(),
        ),
        Provider::Tinify => (&mut config.tinify_keys, config.active_tinify_key_id.clone()),
    };
    let selected_id = key_id.map(ToOwned::to_owned).or(active_id);
    let index = entries
        .iter()
        .position(|entry| Some(entry.id.as_str()) == selected_id.as_deref())
        .or_else(|| {
            key_id
                .is_none()
                .then(|| (!entries.is_empty()).then_some(0))
                .flatten()
        });

    if let Some(index) = index {
        let entry = &mut entries[index];
        entry.quota_exhausted = true;
        entry.remaining = Some(0);
        entry.last_checked_at = Some(checked_at.clone());
    }

    if matches!(provider, Provider::Tinify) {
        config.tinify_last_checked_at = Some(checked_at);
    }
}

pub fn api_key_for(provider: Provider, key_id: Option<&str>) -> Result<String, ConfigError> {
    let config = load_raw_config()?;
    let key = match provider {
        Provider::Compresto => selected_entry(
            &config.compresto_keys,
            key_id,
            config.active_compresto_key_id.as_deref(),
        )
        .map(|entry| entry.key.clone())
        .or_else(|| {
            key_id
                .is_none()
                .then(|| non_empty(config.compresto_api_key))
                .flatten()
        }),
        Provider::Tinify => selected_entry(
            &config.tinify_keys,
            key_id,
            config.active_tinify_key_id.as_deref(),
        )
        .map(|entry| entry.key.clone())
        .or_else(|| {
            key_id
                .is_none()
                .then(|| non_empty(config.tinify_api_key))
                .flatten()
        }),
    };
    key.ok_or(ConfigError::MissingApiKey(provider))
}

fn save_exact_config(config: &AppConfig) -> Result<(), ConfigError> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(
        path,
        serde_json::to_string_pretty(&normalize_app_config(config.clone()))?,
    )?;
    Ok(())
}

fn normalize_app_config(mut config: AppConfig) -> AppConfig {
    if !matches!(config.language.as_str(), "zh" | "en") {
        config.language = "zh".to_string();
    }
    config.watch_folder_path = config
        .watch_folder_path
        .and_then(|path| (!path.trim().is_empty()).then(|| path.trim().to_string()));
    normalize_watch_folders(&mut config);
    if config.watch_folders.is_empty() {
        config.watch_folder_enabled = false;
    }

    if config.compresto_keys.is_empty() && !config.compresto_api_key.trim().is_empty() {
        config.compresto_keys.push(entry_from_legacy(
            Provider::Compresto,
            &config.compresto_api_key,
            None,
            None,
            None,
            None,
        ));
    }
    if config.tinify_keys.is_empty() && !config.tinify_api_key.trim().is_empty() {
        config.tinify_keys.push(entry_from_legacy(
            Provider::Tinify,
            &config.tinify_api_key,
            config.tinify_compression_count,
            None,
            None,
            config.tinify_last_checked_at.clone(),
        ));
    }

    normalize_entries(Provider::Compresto, &mut config.compresto_keys);
    normalize_entries(Provider::Tinify, &mut config.tinify_keys);
    config.compresto_api_key = active_entry(
        &config.compresto_keys,
        config.active_compresto_key_id.as_deref(),
    )
    .map(|entry| entry.key.clone())
    .or_else(|| config.compresto_keys.first().map(|entry| entry.key.clone()))
    .unwrap_or_default();
    config.tinify_api_key =
        active_entry(&config.tinify_keys, config.active_tinify_key_id.as_deref())
            .map(|entry| entry.key.clone())
            .or_else(|| config.tinify_keys.first().map(|entry| entry.key.clone()))
            .unwrap_or_default();

    config.active_compresto_key_id =
        normalize_active_id(config.active_compresto_key_id, &config.compresto_keys);
    config.active_tinify_key_id =
        normalize_active_id(config.active_tinify_key_id, &config.tinify_keys);
    if let Some(entry) = active_entry(&config.tinify_keys, config.active_tinify_key_id.as_deref()) {
        config.tinify_compression_count = entry.used;
        config.tinify_last_checked_at = entry.last_checked_at.clone();
    } else {
        config.tinify_compression_count = None;
        config.tinify_last_checked_at = None;
    }
    config
}

fn normalize_watch_folders(config: &mut AppConfig) {
    if config.watch_folders.is_empty() {
        if let Some(path) = config.watch_folder_path.clone() {
            config.watch_folders.push(WatchFolderConfig {
                id: watch_folder_id(&path, 0),
                path,
                enabled: config.watch_folder_enabled,
                last_scanned_at: None,
                last_error: None,
            });
        }
    }

    for (index, folder) in config.watch_folders.iter_mut().enumerate() {
        folder.path = folder.path.trim().to_string();
        if folder.id.trim().is_empty() {
            folder.id = watch_folder_id(&folder.path, index);
        }
    }
    config
        .watch_folders
        .retain(|folder| !folder.path.is_empty());
    dedupe_watch_folders(&mut config.watch_folders);
    config.watch_folder_path = config
        .watch_folders
        .first()
        .map(|folder| folder.path.clone());
    config.watch_folder_enabled = config.watch_folders.iter().any(|folder| folder.enabled);
}

fn dedupe_watch_folders(folders: &mut Vec<WatchFolderConfig>) {
    let mut seen = std::collections::BTreeSet::new();
    folders.retain(|folder| seen.insert(folder.path.clone()));
}

fn clear_deleted_masked_legacy_fields(config: &mut AppConfig) {
    if config.compresto_keys.is_empty()
        && config.active_compresto_key_id.is_none()
        && is_masked_secret(&config.compresto_api_key)
    {
        config.compresto_api_key.clear();
    }
    if config.tinify_keys.is_empty()
        && config.active_tinify_key_id.is_none()
        && is_masked_secret(&config.tinify_api_key)
    {
        config.tinify_api_key.clear();
        config.tinify_compression_count = None;
        config.tinify_last_checked_at = None;
    }
}

fn normalize_entries(provider: Provider, entries: &mut Vec<ApiKeyEntry>) {
    entries.retain(|entry| !entry.key.trim().is_empty() || !entry.id.trim().is_empty());
    for (index, entry) in entries.iter_mut().enumerate() {
        if entry.id.trim().is_empty() {
            entry.id = key_id(provider, &entry.key, index);
        }
        if entry.label.trim().is_empty() {
            entry.label = mask_secret(&entry.key);
        }
    }
}

fn ensure_unique_keys(provider: Provider, entries: &[ApiKeyEntry]) -> Result<(), ConfigError> {
    for (index, entry) in entries.iter().enumerate() {
        let key = entry.key.trim();
        if key.is_empty() || is_masked_secret(key) {
            continue;
        }
        if entries[index + 1..]
            .iter()
            .any(|candidate| candidate.key.trim() == key)
        {
            return Err(ConfigError::DuplicateApiKey(provider));
        }
    }
    Ok(())
}

fn merge_preserved_keys(next: &mut [ApiKeyEntry], existing: &[ApiKeyEntry]) {
    for entry in next {
        if entry.key.contains('•') {
            if let Some(previous) = existing.iter().find(|candidate| candidate.id == entry.id) {
                entry.key = previous.key.clone();
            }
        }
    }
}

fn update_key_usage_fields(
    config: &mut AppConfig,
    provider: Provider,
    key_id: Option<&str>,
    used: Option<u32>,
    limit: Option<u32>,
    remaining: Option<u32>,
) {
    let normalized = normalize_app_config(config.clone());
    *config = normalized;
    let (entries, active_id) = match provider {
        Provider::Compresto => (
            &mut config.compresto_keys,
            config.active_compresto_key_id.clone(),
        ),
        Provider::Tinify => (&mut config.tinify_keys, config.active_tinify_key_id.clone()),
    };
    let selected_id = key_id.map(ToOwned::to_owned).or(active_id);
    let index = entries
        .iter()
        .position(|entry| Some(entry.id.as_str()) == selected_id.as_deref())
        .or_else(|| {
            key_id
                .is_none()
                .then(|| (!entries.is_empty()).then_some(0))
                .flatten()
        });
    if let Some(index) = index {
        let entry = &mut entries[index];
        entry.used = used;
        entry.limit = limit;
        entry.remaining = remaining;
        entry.last_checked_at = Some(chrono::Utc::now().to_rfc3339());
        entry.quota_exhausted = false;
    }
}

fn selected_entry<'a>(
    entries: &'a [ApiKeyEntry],
    key_id: Option<&str>,
    active_id: Option<&str>,
) -> Option<&'a ApiKeyEntry> {
    match key_id {
        Some(key_id) => entries.iter().find(|entry| entry.id == key_id),
        None => active_entry(entries, active_id),
    }
}

fn active_entry<'a>(
    entries: &'a [ApiKeyEntry],
    active_id: Option<&str>,
) -> Option<&'a ApiKeyEntry> {
    entries
        .iter()
        .find(|entry| Some(entry.id.as_str()) == active_id)
        .or_else(|| entries.first())
}

fn normalize_active_id(active_id: Option<String>, entries: &[ApiKeyEntry]) -> Option<String> {
    active_id
        .filter(|id| entries.iter().any(|entry| &entry.id == id))
        .or_else(|| entries.first().map(|entry| entry.id.clone()))
}

fn entry_from_legacy(
    provider: Provider,
    key: &str,
    used: Option<u32>,
    limit: Option<u32>,
    remaining: Option<u32>,
    last_checked_at: Option<String>,
) -> ApiKeyEntry {
    ApiKeyEntry {
        id: key_id(provider, key, 0),
        label: mask_secret(key),
        key: key.to_string(),
        used,
        limit,
        remaining,
        last_checked_at,
        quota_exhausted: false,
    }
}

fn key_id(provider: Provider, key: &str, index: usize) -> String {
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    index.hash(&mut hasher);
    let prefix = match provider {
        Provider::Compresto => "compresto",
        Provider::Tinify => "tinify",
    };
    format!("{prefix}-{:x}", hasher.finish())
}

fn watch_folder_id(path: &str, index: usize) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    index.hash(&mut hasher);
    format!("watch-{:x}", hasher.finish())
}

fn non_empty(value: String) -> Option<String> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

fn is_masked_secret(value: &str) -> bool {
    value.contains('•')
}

fn config_path() -> Result<PathBuf, ConfigError> {
    let base = dirs::config_dir().ok_or(ConfigError::MissingConfigDirectory)?;
    Ok(base.join("TinyImageTool").join("config.json"))
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("Could not locate the system config directory")]
    MissingConfigDirectory,
    #[error("Config file error: {0}")]
    Io(#[from] io::Error),
    #[error("Config JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0:?} API key is not configured")]
    MissingApiKey(Provider),
    #[error("{0:?} API key already exists")]
    DuplicateApiKey(Provider),
}

#[allow(dead_code)]
pub fn config_file_for_tests(base: &Path) -> PathBuf {
    base.join("TinyImageTool").join("config.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, key: &str, used: Option<u32>, remaining: Option<u32>) -> ApiKeyEntry {
        ApiKeyEntry {
            id: id.to_string(),
            label: mask_secret(key),
            key: key.to_string(),
            used,
            limit: None,
            remaining,
            last_checked_at: None,
            quota_exhausted: false,
        }
    }

    #[test]
    fn clears_masked_legacy_key_when_all_entries_are_deleted() {
        let mut config = AppConfig {
            compresto_api_key: "abcd••••efgh".to_string(),
            tinify_api_key: "tiny••••key1".to_string(),
            tinify_compression_count: Some(7),
            tinify_last_checked_at: Some("2026-05-26T00:00:00Z".to_string()),
            ..AppConfig::default()
        };

        clear_deleted_masked_legacy_fields(&mut config);
        let normalized = normalize_app_config(config);

        assert!(normalized.compresto_api_key.is_empty());
        assert!(normalized.compresto_keys.is_empty());
        assert!(normalized.tinify_api_key.is_empty());
        assert!(normalized.tinify_keys.is_empty());
        assert_eq!(normalized.tinify_compression_count, None);
        assert_eq!(normalized.tinify_last_checked_at, None);
    }

    #[test]
    fn updates_usage_only_for_requested_key_id() {
        let mut config = AppConfig {
            compresto_keys: vec![
                entry("key-a", "alpha-key", Some(3), Some(97)),
                entry("key-b", "beta-key", Some(10), Some(90)),
            ],
            active_compresto_key_id: Some("key-a".to_string()),
            ..AppConfig::default()
        };

        update_key_usage_fields(
            &mut config,
            Provider::Compresto,
            Some("key-b"),
            Some(42),
            Some(100),
            Some(58),
        );

        let first = config
            .compresto_keys
            .iter()
            .find(|entry| entry.id == "key-a")
            .unwrap();
        let second = config
            .compresto_keys
            .iter()
            .find(|entry| entry.id == "key-b")
            .unwrap();

        assert_eq!(first.used, Some(3));
        assert_eq!(first.remaining, Some(97));
        assert_eq!(second.used, Some(42));
        assert_eq!(second.limit, Some(100));
        assert_eq!(second.remaining, Some(58));
        assert!(!second.quota_exhausted);
    }

    #[test]
    fn marks_quota_exhausted_for_requested_key_id() {
        let mut config = AppConfig {
            tinify_keys: vec![
                entry("key-a", "alpha-key", Some(3), None),
                entry("key-b", "beta-key", Some(10), None),
            ],
            active_tinify_key_id: Some("key-a".to_string()),
            ..AppConfig::default()
        };

        update_key_quota_exhausted(&mut config, Provider::Tinify, Some("key-b"));

        let first = config
            .tinify_keys
            .iter()
            .find(|entry| entry.id == "key-a")
            .unwrap();
        let second = config
            .tinify_keys
            .iter()
            .find(|entry| entry.id == "key-b")
            .unwrap();

        assert!(!first.quota_exhausted);
        assert!(second.quota_exhausted);
        assert_eq!(second.remaining, Some(0));
    }

    #[test]
    fn migrates_legacy_watch_folder_to_watch_folders() {
        let config = AppConfig {
            watch_folder_enabled: true,
            watch_folder_path: Some("/tmp/images".to_string()),
            ..AppConfig::default()
        };

        let normalized = normalize_app_config(config);

        assert_eq!(normalized.watch_folders.len(), 1);
        assert_eq!(normalized.watch_folders[0].path, "/tmp/images");
        assert!(normalized.watch_folders[0].enabled);
        assert_eq!(normalized.watch_folder_path.as_deref(), Some("/tmp/images"));
        assert!(normalized.watch_folder_enabled);
    }

    #[test]
    fn deduplicates_watch_folders_by_path() {
        let config = AppConfig {
            watch_folders: vec![
                WatchFolderConfig {
                    id: "a".to_string(),
                    path: "/tmp/images".to_string(),
                    enabled: true,
                    last_scanned_at: None,
                    last_error: None,
                },
                WatchFolderConfig {
                    id: "b".to_string(),
                    path: "/tmp/images".to_string(),
                    enabled: true,
                    last_scanned_at: None,
                    last_error: None,
                },
            ],
            ..AppConfig::default()
        };

        let normalized = normalize_app_config(config);

        assert_eq!(normalized.watch_folders.len(), 1);
    }

    #[test]
    fn defaults_and_normalizes_language() {
        let mut config = AppConfig::default();
        assert_eq!(config.language, "zh");
        assert!(config.preserve_comfy_workflow);

        config.language = "fr".to_string();
        let normalized = normalize_app_config(config);

        assert_eq!(normalized.language, "zh");
        assert!(normalized.preserve_comfy_workflow);
    }
}
