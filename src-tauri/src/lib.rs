mod api;
mod config;
mod diagnostics;
mod files;
mod metadata;
mod models;

use std::path::Path;

use api::{
    compress_with_compresto, compress_with_tinify, fetch_compresto_usage, fetch_tinify_usage,
};
use config::{load_app_config, save_app_config};
use files::{scan_image_paths, write_output_file};
use models::{
    AppConfig, CompressOptions, CompressResult, ImageFile, OutputPolicy, Provider, UsageResult,
};

#[tauri::command]
fn scan_paths(paths: Vec<String>) -> Result<Vec<ImageFile>, String> {
    scan_image_paths(paths).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_config() -> Result<AppConfig, String> {
    load_app_config().map_err(|error| error.to_string())
}

#[tauri::command]
fn save_config(config: AppConfig) -> Result<AppConfig, String> {
    save_app_config(&config).map_err(|error| error.to_string())?;
    load_app_config().map_err(|error| error.to_string())
}

#[tauri::command]
async fn refresh_usage(provider: Provider, key_id: Option<String>) -> Result<UsageResult, String> {
    match provider {
        Provider::Compresto => fetch_compresto_usage(key_id.as_deref())
            .await
            .map_err(|error| error.to_string()),
        Provider::Tinify => fetch_tinify_usage(key_id.as_deref())
            .await
            .map_err(|error| error.to_string()),
    }
}

#[tauri::command]
async fn compress_image(
    path: String,
    provider: Provider,
    key_id: Option<String>,
    options: CompressOptions,
    output_policy: OutputPolicy,
    custom_output_dir: Option<String>,
) -> Result<CompressResult, String> {
    if metadata::is_marked_compressed_path(Path::new(&path)).map_err(|error| error.to_string())? {
        let source_size = std::fs::metadata(&path)
            .map_err(|error| error.to_string())?
            .len();
        return Ok(CompressResult {
            source_path: path.clone(),
            output_path: path,
            original_size: source_size,
            compressed_size: source_size,
            savings_percent: 0.0,
            provider,
            usage: None,
            skipped: true,
            message: "Already compressed, skipped".to_string(),
        });
    }

    let response = match provider {
        Provider::Compresto => compress_with_compresto(&path, &options, key_id.as_deref()).await,
        Provider::Tinify => compress_with_tinify(&path, &options, key_id.as_deref()).await,
    }
    .map_err(|error| error.to_string())?;

    let output_path = write_output_file(
        &path,
        &response.bytes,
        &response.extension,
        &output_policy,
        custom_output_dir,
        &options,
    )
    .map_err(|error| error.to_string())?;

    Ok(CompressResult {
        source_path: path,
        output_path,
        original_size: response.original_size,
        compressed_size: response.compressed_size,
        savings_percent: response.savings_percent,
        provider,
        usage: response.usage,
        skipped: false,
        message: response.message,
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_paths,
            load_config,
            save_config,
            refresh_usage,
            compress_image
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Tiny Image Tool");
}
