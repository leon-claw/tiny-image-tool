use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub enum Provider {
    Compresto,
    Tinify,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub compresto_api_key: String,
    #[serde(default)]
    pub tinify_api_key: String,
    #[serde(default)]
    pub tinify_compression_count: Option<u32>,
    #[serde(default)]
    pub tinify_last_checked_at: Option<String>,
    #[serde(default)]
    pub compresto_keys: Vec<ApiKeyEntry>,
    #[serde(default)]
    pub tinify_keys: Vec<ApiKeyEntry>,
    #[serde(default)]
    pub active_compresto_key_id: Option<String>,
    #[serde(default)]
    pub active_tinify_key_id: Option<String>,
    #[serde(default)]
    pub watch_folder_enabled: bool,
    #[serde(default)]
    pub watch_folder_path: Option<String>,
    #[serde(default)]
    pub watch_folders: Vec<WatchFolderConfig>,
    #[serde(default = "default_true")]
    pub keep_awake_during_compression: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            compresto_api_key: String::new(),
            tinify_api_key: String::new(),
            tinify_compression_count: None,
            tinify_last_checked_at: None,
            compresto_keys: Vec::new(),
            tinify_keys: Vec::new(),
            active_compresto_key_id: None,
            active_tinify_key_id: None,
            watch_folder_enabled: false,
            watch_folder_path: None,
            watch_folders: Vec::new(),
            keep_awake_during_compression: true,
        }
    }
}

impl AppConfig {
    pub fn masked(&self) -> Self {
        Self {
            compresto_api_key: mask_secret(&self.compresto_api_key),
            tinify_api_key: mask_secret(&self.tinify_api_key),
            tinify_compression_count: self.tinify_compression_count,
            tinify_last_checked_at: self.tinify_last_checked_at.clone(),
            compresto_keys: self
                .compresto_keys
                .iter()
                .map(ApiKeyEntry::masked)
                .collect(),
            tinify_keys: self.tinify_keys.iter().map(ApiKeyEntry::masked).collect(),
            active_compresto_key_id: self.active_compresto_key_id.clone(),
            active_tinify_key_id: self.active_tinify_key_id.clone(),
            watch_folder_enabled: self.watch_folder_enabled,
            watch_folder_path: self.watch_folder_path.clone(),
            watch_folders: self.watch_folders.clone(),
            keep_awake_during_compression: self.keep_awake_during_compression,
        }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchFolderEvent {
    pub folder: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchFolderConfig {
    pub id: String,
    pub path: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub last_scanned_at: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchFolderScan {
    pub folder: String,
    pub all_files: usize,
    pub supported_files: usize,
    pub compressed_files: usize,
    pub uncompressed_files: usize,
    pub files: Vec<ImageFile>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub used: Option<u32>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub remaining: Option<u32>,
    #[serde(default)]
    pub last_checked_at: Option<String>,
}

impl ApiKeyEntry {
    pub fn masked(&self) -> Self {
        let masked_key = mask_secret(&self.key);
        Self {
            id: self.id.clone(),
            label: if self.label.is_empty() {
                masked_key.clone()
            } else {
                self.label.clone()
            },
            key: masked_key,
            used: self.used,
            limit: self.limit,
            remaining: self.remaining,
            last_checked_at: self.last_checked_at.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFile {
    pub path: String,
    pub name: String,
    pub extension: String,
    pub size: u64,
    pub is_compressed: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressOptions {
    pub quality: u8,
    pub format: String,
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
    pub preserve_metadata: bool,
    pub preserve_comfy_workflow: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub enum OutputPolicy {
    Subdirectory,
    Overwrite,
    CustomDirectory,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageResult {
    pub provider: Provider,
    pub status: String,
    pub used: Option<u32>,
    pub limit: Option<u32>,
    pub remaining: Option<u32>,
    pub last_checked_at: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct ApiImageResponse {
    pub bytes: Vec<u8>,
    pub original_size: u64,
    pub compressed_size: u64,
    pub savings_percent: f64,
    pub extension: String,
    pub usage: Option<UsageResult>,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressResult {
    pub source_path: String,
    pub output_path: String,
    pub original_size: u64,
    pub compressed_size: u64,
    pub savings_percent: f64,
    pub provider: Provider,
    pub usage: Option<UsageResult>,
    pub skipped: bool,
    pub message: String,
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn mask_secret(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }

    if value.chars().count() <= 8 {
        return "••••".to_string();
    }

    let start: String = value.chars().take(4).collect();
    let end: String = value
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{start}••••{end}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_secrets_without_revealing_short_values() {
        assert_eq!(mask_secret(""), "");
        assert_eq!(mask_secret("abc"), "••••");
        assert_eq!(mask_secret("abcd1234efgh"), "abcd••••efgh");
    }
}
