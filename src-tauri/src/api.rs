use std::path::Path;

use base64::{engine::general_purpose, Engine as _};
use reqwest::{
    header::{HeaderMap, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_TYPE, LOCATION, RANGE},
    multipart, Client, Response, StatusCode,
};
use serde_json::{json, Value};
use tokio::fs;

use crate::{
    config::{api_key_for, update_tinify_usage_for_key, update_usage_for_key},
    diagnostics::{log_api_error, log_api_event, log_api_response, summarize_headers},
    models::{now_iso, ApiImageResponse, CompressOptions, Provider, UsageResult},
};

const COMPRESTO_API_BASE: &str = "https://api.compresto.app";
const TINIFY_SHRINK_URL: &str = "https://api.tinify.com/shrink";
const TINIFY_RESULT_RETRIES: usize = 10;

pub async fn compress_with_compresto(
    path: &str,
    options: &CompressOptions,
    key_id: Option<&str>,
) -> Result<ApiImageResponse, ApiError> {
    let api_key = api_key_for(Provider::Compresto, key_id)?;
    ensure_key(&api_key, "Compresto")?;

    let bytes = fs::read(path).await?;
    let original_size = bytes.len() as u64;
    let file_name = Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("image")
        .to_string();

    let mut form = multipart::Form::new()
        .part("file", multipart::Part::bytes(bytes).file_name(file_name))
        .text("quality", options.quality.to_string());

    if options.format != "same" {
        form = form.text("format", options.format.clone());
    }
    if let Some(width) = options.max_width {
        form = form.text("maxWidth", width.to_string());
    }
    if let Some(height) = options.max_height {
        form = form.text("maxHeight", height.to_string());
    }

    let response = api_client()?
        .post(format!("{COMPRESTO_API_BASE}/v1/compress"))
        .header("X-API-Key", api_key)
        .header(ACCEPT_ENCODING, "identity")
        .multipart(form)
        .send()
        .await
        .map_err(|error| map_reqwest_error("Compresto", "compress.send", error, None))?;

    let headers = response.headers().clone();
    log_api_response(
        "Compresto",
        "compress.response",
        response.status(),
        &headers,
    );
    if !response.status().is_success() {
        return Err(read_status_error("Compresto", "compress.error_body", response).await);
    }

    let output_bytes =
        read_response_bytes("Compresto", "compress.body", response, Some(&headers)).await?;
    let compressed_size = output_bytes.len() as u64;
    Ok(ApiImageResponse {
        bytes: output_bytes,
        original_size: header_u64(&headers, "X-Original-Size").unwrap_or(original_size),
        compressed_size: header_u64(&headers, "X-Compressed-Size").unwrap_or(compressed_size),
        savings_percent: header_f64(&headers, "X-Savings-Percent")
            .unwrap_or_else(|| savings_percent(original_size, compressed_size)),
        extension: output_extension(options, path),
        usage: None,
        message: "Compressed with Compresto".to_string(),
    })
}

pub async fn fetch_compresto_usage(key_id: Option<&str>) -> Result<UsageResult, ApiError> {
    let api_key = api_key_for(Provider::Compresto, key_id)?;
    ensure_key(&api_key, "Compresto")?;

    let response = api_client()?
        .get(format!("{COMPRESTO_API_BASE}/v1/usage"))
        .header("X-API-Key", api_key)
        .header(ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|error| map_reqwest_error("Compresto", "usage.send", error, None))?;

    let headers = response.headers().clone();
    log_api_response("Compresto", "usage.response", response.status(), &headers);
    if !response.status().is_success() {
        return Err(read_status_error("Compresto", "usage.error_body", response).await);
    }

    let body = read_response_bytes("Compresto", "usage.body", response, Some(&headers)).await?;
    let value = serde_json::from_slice::<Value>(&body)?;
    log_api_event(
        "Compresto",
        "usage.body",
        &String::from_utf8_lossy(&body)
            .chars()
            .take(1200)
            .collect::<String>(),
    );
    let used = value_u32_deep(
        &value,
        &[
            "used",
            "usage",
            "count",
            "requests",
            "requestCount",
            "apiCalls",
            "calls",
            "compressions",
            "creditsUsed",
            "usedCredits",
        ],
    );
    let limit = value_u32_deep(
        &value,
        &[
            "limit",
            "quota",
            "monthlyLimit",
            "max",
            "maximum",
            "allowed",
            "apiCallLimit",
            "credits",
            "totalCredits",
        ],
    );
    let remaining = value_u32_deep(
        &value,
        &["remaining", "remainingCredits", "creditsLeft", "left"],
    )
    .or_else(|| match (used, limit) {
        (Some(used), Some(limit)) => Some(limit.saturating_sub(used)),
        _ => None,
    });

    let result = UsageResult {
        provider: Provider::Compresto,
        status: "ok".to_string(),
        used,
        limit,
        remaining,
        last_checked_at: now_iso(),
        message: "Compresto usage refreshed".to_string(),
    };
    let _ = update_usage_for_key(Provider::Compresto, key_id, &result);
    Ok(result)
}

pub async fn compress_with_tinify(
    path: &str,
    options: &CompressOptions,
    key_id: Option<&str>,
) -> Result<ApiImageResponse, ApiError> {
    let tinify_key = api_key_for(Provider::Tinify, key_id)?;
    ensure_key(&tinify_key, "Tinify")?;

    let input_bytes = fs::read(path).await?;
    let original_size = input_bytes.len() as u64;
    let auth = tinify_auth_header(&tinify_key);
    let client = api_client()?;

    let shrink = client
        .post(TINIFY_SHRINK_URL)
        .header(AUTHORIZATION, auth.clone())
        .header(CONTENT_TYPE, "application/octet-stream")
        .header(ACCEPT_ENCODING, "identity")
        .body(input_bytes)
        .send()
        .await
        .map_err(|error| map_reqwest_error("Tinify", "shrink.send", error, None))?;

    let shrink_headers = shrink.headers().clone();
    log_api_response(
        "Tinify",
        "shrink.response",
        shrink.status(),
        &shrink_headers,
    );
    if !shrink.status().is_success() {
        return Err(read_status_error("Tinify", "shrink.error_body", shrink).await);
    }

    let result_url = shrink_headers
        .get(LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(ApiError::MissingTinifyLocation)?
        .to_string();

    let (output_bytes, output_headers) =
        fetch_tinify_result_bytes(&client, &result_url, &auth, options).await?;
    let compressed_size = output_bytes.len() as u64;
    let usage = tinify_usage_from_headers(&output_headers)
        .or_else(|| tinify_usage_from_headers(&shrink_headers));

    if let Some(usage) = &usage {
        if let Some(used) = usage.used {
            let _ = update_tinify_usage_for_key(key_id, used, usage.last_checked_at.clone());
        }
    }

    Ok(ApiImageResponse {
        bytes: output_bytes,
        original_size,
        compressed_size,
        savings_percent: savings_percent(original_size, compressed_size),
        extension: output_extension(options, path),
        usage,
        message: "Compressed with Tinify".to_string(),
    })
}

pub async fn fetch_tinify_usage(key_id: Option<&str>) -> Result<UsageResult, ApiError> {
    let tinify_key = api_key_for(Provider::Tinify, key_id)?;
    ensure_key(&tinify_key, "Tinify")?;

    // Tinify has no standalone usage endpoint; a dummy shrink request returns Compression-Count.
    let response = api_client()?
        .post(TINIFY_SHRINK_URL)
        .header(AUTHORIZATION, tinify_auth_header(&tinify_key))
        .header(ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|error| map_reqwest_error("Tinify", "usage.send", error, None))?;

    let headers = response.headers().clone();
    log_api_response("Tinify", "usage.response", response.status(), &headers);
    if let Some(usage) = tinify_usage_from_headers(&headers) {
        if let Some(used) = usage.used {
            let _ = update_tinify_usage_for_key(key_id, used, usage.last_checked_at.clone());
        }
        return Ok(UsageResult {
            message: "Tinify usage refreshed from Compression-Count".to_string(),
            ..usage
        });
    }

    if response.status() == StatusCode::BAD_REQUEST {
        return Ok(UsageResult {
            provider: Provider::Tinify,
            status: "unknown".to_string(),
            used: None,
            limit: None,
            remaining: None,
            last_checked_at: now_iso(),
            message: "Tinify validated the API key but did not return Compression-Count"
                .to_string(),
        });
    }

    Err(read_status_error("Tinify", "usage.error_body", response).await)
}

fn tinify_auth_header(api_key: &str) -> String {
    let token = general_purpose::STANDARD.encode(format!("api:{api_key}"));
    format!("Basic {token}")
}

fn tinify_needs_options(options: &CompressOptions) -> bool {
    options.format != "same"
        || options.max_width.is_some()
        || options.max_height.is_some()
        || options.preserve_metadata
}

fn tinify_options_payload(options: &CompressOptions) -> Value {
    let mut payload = serde_json::Map::new();

    if options.format != "same" {
        payload.insert(
            "convert".to_string(),
            json!({ "type": tinify_mime_type(&options.format) }),
        );
    }

    if options.max_width.is_some() || options.max_height.is_some() {
        let mut resize = serde_json::Map::new();
        resize.insert("method".to_string(), json!("fit"));
        if let Some(width) = options.max_width {
            resize.insert("width".to_string(), json!(width));
        }
        if let Some(height) = options.max_height {
            resize.insert("height".to_string(), json!(height));
        }
        payload.insert("resize".to_string(), Value::Object(resize));
    }

    if options.preserve_metadata {
        payload.insert(
            "preserve".to_string(),
            json!(["copyright", "creation", "location"]),
        );
    }

    Value::Object(payload)
}

async fn fetch_tinify_result_bytes(
    client: &Client,
    result_url: &str,
    auth: &str,
    options: &CompressOptions,
) -> Result<(Vec<u8>, HeaderMap), ApiError> {
    if !tinify_needs_options(options) {
        return fetch_tinify_result_bytes_resumable(client, result_url, auth).await;
    }

    for attempt in 1..=TINIFY_RESULT_RETRIES {
        let send_stage = format!("result-options.send.attempt{attempt}");
        let response_stage = format!("result.response.attempt{attempt}");
        let body_stage = format!("result.body.attempt{attempt}");

        let response = client
            .post(result_url)
            .header(AUTHORIZATION, auth)
            .header(ACCEPT_ENCODING, "identity")
            .json(&tinify_options_payload(options))
            .send()
            .await
            .map_err(|error| map_reqwest_error("Tinify", &send_stage, error, None))?;
        let headers = response.headers().clone();
        log_api_response("Tinify", &response_stage, response.status(), &headers);
        if !response.status().is_success() {
            return Err(read_status_error("Tinify", "result.error_body", response).await);
        }

        match read_response_bytes("Tinify", &body_stage, response, Some(&headers)).await {
            Ok(bytes) => return Ok((bytes, headers)),
            Err(error) if is_retryable_body_error(&error) && attempt < TINIFY_RESULT_RETRIES => {
                log_api_error(
                    "Tinify",
                    &format!("result.body.retry.attempt{attempt}"),
                    &error.to_string(),
                );
            }
            Err(error) => return Err(error),
        }
    }

    unreachable!("Tinify result retry loop always returns");
}

async fn fetch_tinify_result_bytes_resumable(
    client: &Client,
    result_url: &str,
    auth: &str,
) -> Result<(Vec<u8>, HeaderMap), ApiError> {
    let mut bytes = Vec::new();
    let mut expected_total = None;
    let mut last_headers = HeaderMap::new();

    for attempt in 1..=TINIFY_RESULT_RETRIES {
        let offset = bytes.len();
        let send_stage = format!("result-download.send.attempt{attempt}.offset{offset}");
        let response_stage = format!("result.response.attempt{attempt}.offset{offset}");
        let body_stage = format!("result.body.attempt{attempt}");

        let mut request = client
            .get(result_url)
            .header(AUTHORIZATION, auth)
            .header(ACCEPT_ENCODING, "identity");
        if offset > 0 {
            request = request.header(RANGE, format!("bytes={offset}-"));
        }

        let response = request
            .send()
            .await
            .map_err(|error| map_reqwest_error("Tinify", &send_stage, error, None))?;
        let headers = response.headers().clone();
        log_api_response("Tinify", &response_stage, response.status(), &headers);
        last_headers = headers.clone();

        let mut response_offset = offset;
        if offset > 0 && response.status() == StatusCode::OK {
            log_api_error(
                "Tinify",
                &response_stage,
                "server ignored Range request; restarting full download",
            );
            bytes.clear();
            expected_total = None;
            response_offset = 0;
        } else if offset > 0 && response.status() != StatusCode::PARTIAL_CONTENT {
            return Err(read_status_error("Tinify", "result.range_error_body", response).await);
        }

        if !response.status().is_success() {
            return Err(read_status_error("Tinify", "result.error_body", response).await);
        }

        expected_total = content_range_total(&headers)
            .or_else(|| content_length_header(&headers).map(|length| response_offset + length))
            .or(expected_total);

        match read_response_into(
            "Tinify",
            &body_stage,
            response,
            Some(&headers),
            &mut bytes,
            expected_total,
        )
        .await
        {
            Ok(()) => {
                if expected_total
                    .map(|expected| bytes.len() >= expected)
                    .unwrap_or(true)
                {
                    return Ok((bytes, last_headers));
                }
                log_api_error(
                    "Tinify",
                    &format!("result.body.incomplete.attempt{attempt}"),
                    &format!(
                        "downloaded={} expected={}",
                        bytes.len(),
                        expected_total
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "unknown".to_string())
                    ),
                );
            }
            Err(error) if is_retryable_body_error(&error) && attempt < TINIFY_RESULT_RETRIES => {
                log_api_error(
                    "Tinify",
                    &format!("result.body.resume.attempt{attempt}"),
                    &format!(
                        "{}; keeping downloaded={} expected={}",
                        error,
                        bytes.len(),
                        expected_total
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "unknown".to_string())
                    ),
                );
            }
            Err(error) => return Err(error),
        }
    }

    Err(ApiError::IncompleteBody {
        service: "Tinify".to_string(),
        stage: "result.body".to_string(),
        downloaded: bytes.len(),
        expected: expected_total,
        headers: summarize_headers(&last_headers),
    })
}

fn tinify_usage_from_headers(headers: &HeaderMap) -> Option<UsageResult> {
    header_u32(headers, "Compression-Count").map(|used| UsageResult {
        provider: Provider::Tinify,
        status: "ok".to_string(),
        used: Some(used),
        limit: None,
        remaining: None,
        last_checked_at: now_iso(),
        message: "Tinify Compression-Count updated".to_string(),
    })
}

fn output_extension(options: &CompressOptions, path: &str) -> String {
    if options.format != "same" {
        return options.format.clone();
    }
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("same")
        .to_ascii_lowercase()
}

fn tinify_mime_type(format: &str) -> String {
    match format {
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        other => format!("image/{other}"),
    }
}

fn savings_percent(original_size: u64, compressed_size: u64) -> f64 {
    if original_size == 0 {
        return 0.0;
    }
    let saved = original_size.saturating_sub(compressed_size) as f64;
    ((saved / original_size as f64) * 100.0 * 10.0).round() / 10.0
}

fn ensure_key(value: &str, service: &str) -> Result<(), ApiError> {
    if value.trim().is_empty() {
        Err(ApiError::MissingApiKey(service.to_string()))
    } else {
        Ok(())
    }
}

fn api_client() -> Result<Client, ApiError> {
    Client::builder()
        .http1_only()
        .no_gzip()
        .no_brotli()
        .no_zstd()
        .no_deflate()
        .build()
        .map_err(|error| map_reqwest_error("HTTP", "client.build", error, None))
}

async fn read_response_bytes(
    service: &str,
    stage: &str,
    response: Response,
    headers: Option<&HeaderMap>,
) -> Result<Vec<u8>, ApiError> {
    let expected = headers.and_then(content_length_header);
    let mut bytes = Vec::with_capacity(expected.unwrap_or_default().min(8 * 1024 * 1024));

    read_response_into(service, stage, response, headers, &mut bytes, expected).await?;
    Ok(bytes)
}

async fn read_response_into(
    service: &str,
    stage: &str,
    mut response: Response,
    headers: Option<&HeaderMap>,
    bytes: &mut Vec<u8>,
    expected_total: Option<usize>,
) -> Result<(), ApiError> {
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => bytes.extend_from_slice(&chunk),
            Ok(None) => {
                if let Some(expected_total) = expected_total {
                    if bytes.len() < expected_total {
                        log_api_error(
                            service,
                            stage,
                            &format!(
                                "body length mismatch downloaded={} expected={}",
                                bytes.len(),
                                expected_total
                            ),
                        );
                    }
                }
                return Ok(());
            }
            Err(error) => {
                let stage_with_progress = format!(
                    "{stage}.downloaded{}/{}",
                    bytes.len(),
                    expected_total
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "unknown".to_string())
                );
                return Err(map_reqwest_error(
                    service,
                    &stage_with_progress,
                    error,
                    headers,
                ));
            }
        }
    }
}

async fn read_status_error(service: &str, stage: &str, response: Response) -> ApiError {
    let status = response.status();
    let headers = response.headers().clone();
    let body = match read_response_bytes(service, stage, response, Some(&headers)).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).chars().take(2000).collect(),
        Err(error) => format!("[failed to read error body: {error}]"),
    };
    api_status_error(service, status, Some(body))
}

fn map_reqwest_error(
    service: &str,
    stage: &str,
    error: reqwest::Error,
    headers: Option<&HeaderMap>,
) -> ApiError {
    let header_summary = headers.map(summarize_headers).unwrap_or_default();
    log_api_error(
        service,
        stage,
        &format!("{error}; headers={header_summary}"),
    );
    if error.is_decode() {
        ApiError::Decode {
            service: service.to_string(),
            stage: stage.to_string(),
            detail: error.to_string(),
            headers: header_summary,
        }
    } else {
        ApiError::Http(error)
    }
}

fn is_retryable_body_error(error: &ApiError) -> bool {
    matches!(error, ApiError::Decode { .. } | ApiError::Http(_))
}

fn api_status_error(service: &str, status: StatusCode, body: Option<String>) -> ApiError {
    let hint = match status.as_u16() {
        400 => "Invalid request or unsupported options",
        401 => "API key authentication failed",
        413 => "Image file is too large",
        415 => "Image format is not supported",
        429 => "Rate limit or quota has been reached",
        500..=599 => "The remote compression service failed",
        _ => "The remote compression service returned an error",
    };
    ApiError::Remote {
        service: service.to_string(),
        status: status.as_u16(),
        hint: hint.to_string(),
        body: body.unwrap_or_default(),
    }
}

fn value_u32_deep(value: &Value, keys: &[&str]) -> Option<u32> {
    let normalized_keys = keys
        .iter()
        .map(|key| normalize_key(key))
        .collect::<Vec<_>>();
    value_u32_deep_inner(value, &normalized_keys)
}

fn value_u32_deep_inner(value: &Value, normalized_keys: &[String]) -> Option<u32> {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if normalized_keys.contains(&normalize_key(key)) {
                    if let Some(number) = value.as_u64().and_then(|value| u32::try_from(value).ok())
                    {
                        return Some(number);
                    }
                }
            }
            map.values()
                .find_map(|value| value_u32_deep_inner(value, normalized_keys))
        }
        Value::Array(values) => values
            .iter()
            .find_map(|value| value_u32_deep_inner(value, normalized_keys)),
        _ => None,
    }
}

fn normalize_key(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(|character| character.to_lowercase())
        .collect()
}

fn header_u32(headers: &HeaderMap, name: &str) -> Option<u32> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u32>().ok())
}

fn header_u64(headers: &HeaderMap, name: &str) -> Option<u64> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
}

fn header_f64(headers: &HeaderMap, name: &str) -> Option<f64> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<f64>().ok())
}

fn content_length_header(headers: &HeaderMap) -> Option<usize> {
    headers
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
}

fn content_range_total(headers: &HeaderMap) -> Option<usize> {
    let value = headers.get("content-range")?.to_str().ok()?;
    let (_, total) = value.rsplit_once('/')?;
    total.parse::<usize>().ok()
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("{0} API key is not configured")]
    MissingApiKey(String),
    #[error("Config error: {0}")]
    Config(#[from] crate::config::ConfigError),
    #[error("File read error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Network error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("JSON parse error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{service} response decode error during {stage}: {detail}. Headers: {headers}")]
    Decode {
        service: String,
        stage: String,
        detail: String,
        headers: String,
    },
    #[error("{service} incomplete response during {stage}: downloaded {downloaded}/{expected:?} bytes. Headers: {headers}")]
    IncompleteBody {
        service: String,
        stage: String,
        downloaded: usize,
        expected: Option<usize>,
        headers: String,
    },
    #[error("Tinify did not return a result Location header")]
    MissingTinifyLocation,
    #[error("{service} API error {status}: {hint}. {body}")]
    Remote {
        service: String,
        status: u16,
        hint: String,
        body: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderMap, HeaderValue};

    #[test]
    fn calculates_savings_without_negative_values() {
        assert_eq!(savings_percent(100, 40), 60.0);
        assert_eq!(savings_percent(100, 120), 0.0);
        assert_eq!(savings_percent(0, 10), 0.0);
    }

    #[test]
    fn parses_tinify_compression_count_header() {
        let mut headers = HeaderMap::new();
        headers.insert("Compression-Count", HeaderValue::from_static("42"));
        let usage = tinify_usage_from_headers(&headers).unwrap();
        assert_eq!(usage.used, Some(42));
    }

    #[test]
    fn ignores_missing_or_invalid_tinify_usage_header() {
        assert!(tinify_usage_from_headers(&HeaderMap::new()).is_none());

        let mut headers = HeaderMap::new();
        headers.insert("Compression-Count", HeaderValue::from_static("nope"));
        assert!(tinify_usage_from_headers(&headers).is_none());
    }

    #[test]
    fn maps_jpg_to_tinify_jpeg_mime_type() {
        assert_eq!(tinify_mime_type("jpg"), "image/jpeg");
        assert_eq!(tinify_mime_type("webp"), "image/webp");
    }

    #[test]
    fn parses_content_range_total() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "Content-Range",
            HeaderValue::from_static("bytes 549930-3254233/3254234"),
        );
        assert_eq!(content_range_total(&headers), Some(3_254_234));
    }

    #[test]
    fn parses_usage_numbers_from_nested_json() {
        let value = json!({
            "data": {
                "requestsUsed": 17,
                "monthlyLimit": 100
            }
        });
        assert_eq!(value_u32_deep(&value, &["requestsUsed"]), Some(17));
        assert_eq!(value_u32_deep(&value, &["monthlyLimit"]), Some(100));
    }
}
