use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
};

use reqwest::{header::HeaderMap, StatusCode};

use crate::models::now_iso;

pub fn log_path() -> Option<PathBuf> {
    dirs::config_dir().map(|base| base.join("TinyImageTool").join("api.log"))
}

pub fn log_api_response(service: &str, stage: &str, status: StatusCode, headers: &HeaderMap) {
    write_line(&format!(
        "{} service={} stage={} status={} headers={}",
        now_iso(),
        service,
        stage,
        status.as_u16(),
        summarize_headers(headers)
    ));
}

pub fn log_api_error(service: &str, stage: &str, error: &str) {
    write_line(&format!(
        "{} service={} stage={} error={}",
        now_iso(),
        service,
        stage,
        error.replace('\n', " ")
    ));
}

pub fn log_api_event(service: &str, stage: &str, detail: &str) {
    write_line(&format!(
        "{} service={} stage={} detail={}",
        now_iso(),
        service,
        stage,
        detail.replace('\n', " ")
    ));
}

pub fn summarize_headers(headers: &HeaderMap) -> String {
    let names = [
        "content-type",
        "content-length",
        "content-encoding",
        "accept-ranges",
        "content-range",
        "location",
        "compression-count",
        "image-width",
        "image-height",
        "x-original-size",
        "x-compressed-size",
        "x-savings-percent",
    ];

    names
        .iter()
        .filter_map(|name| {
            headers
                .get(*name)
                .and_then(|value| value.to_str().ok())
                .map(|value| format!("{name}={}", sanitize_header_value(name, value)))
        })
        .collect::<Vec<_>>()
        .join(";")
}

fn sanitize_header_value(name: &str, value: &str) -> String {
    if name.eq_ignore_ascii_case("location") {
        return value
            .split('?')
            .next()
            .unwrap_or(value)
            .chars()
            .take(120)
            .collect();
    }
    value.chars().take(120).collect()
}

fn write_line(line: &str) {
    let Some(path) = log_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}
