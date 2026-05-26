use std::{
    fs, io,
    path::{Path, PathBuf},
};

use crate::models::CompressOptions;

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
const MARKER_KEYWORD: &str = "tiny-image-tool";
const MARKER_VALUE: &str = "compressed=v1";
const FOOTER_MARKER: &[u8] = b"\nTINY_IMAGE_TOOL_COMPRESSED_V1\n";
const MARKER_BYTES: &[u8] = b"TINY_IMAGE_TOOL_COMPRESSED_V1";

#[derive(Debug, Clone)]
struct PngChunk {
    kind: [u8; 4],
    data: Vec<u8>,
}

pub fn is_marked_compressed_path(path: &Path) -> Result<bool, MetadataError> {
    let bytes = fs::read(path)?;
    Ok(is_marked_compressed(&bytes))
}

pub fn finalize_output_bytes(
    source_path: &Path,
    compressed_bytes: &[u8],
    target_path: &Path,
    options: &CompressOptions,
) -> Result<Vec<u8>, MetadataError> {
    let source_bytes = if options.preserve_comfy_workflow {
        fs::read(source_path).ok()
    } else {
        None
    };

    let mut output = compressed_bytes.to_vec();
    if is_png_path(target_path) && is_png(&output) {
        let workflow_chunks = source_bytes
            .as_deref()
            .filter(|_| options.preserve_comfy_workflow)
            .and_then(|bytes| extract_comfy_png_chunks(bytes).ok())
            .unwrap_or_default();
        output = add_png_marker_and_chunks(&output, workflow_chunks)?;
    } else if !is_marked_compressed(&output) {
        output = add_binary_marker(&output);
    }

    Ok(output)
}

fn is_marked_compressed(bytes: &[u8]) -> bool {
    if bytes
        .windows(MARKER_BYTES.len())
        .any(|window| window == MARKER_BYTES)
    {
        return true;
    }

    if !is_png(bytes) {
        return false;
    }

    parse_png_chunks(bytes)
        .map(|chunks| {
            chunks.iter().any(|chunk| {
                chunk.kind == *b"tEXt"
                    && text_keyword(&chunk.data)
                        .map(|keyword| keyword == MARKER_KEYWORD)
                        .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn add_binary_marker(bytes: &[u8]) -> Vec<u8> {
    if is_jpeg(bytes) {
        return add_jpeg_comment_marker(bytes);
    }
    if is_webp(bytes) {
        return add_webp_chunk_marker(bytes).unwrap_or_else(|| add_footer_marker(bytes));
    }
    if looks_like_avif(bytes) {
        return add_isobmff_free_marker(bytes);
    }
    add_footer_marker(bytes)
}

fn add_footer_marker(bytes: &[u8]) -> Vec<u8> {
    let mut output = bytes.to_vec();
    output.extend_from_slice(FOOTER_MARKER);
    output
}

fn add_jpeg_comment_marker(bytes: &[u8]) -> Vec<u8> {
    let insert_at = bytes
        .windows(2)
        .rposition(|window| window == [0xff, 0xd9])
        .unwrap_or(bytes.len());
    let mut output = Vec::with_capacity(bytes.len() + MARKER_BYTES.len() + 4);
    output.extend_from_slice(&bytes[..insert_at]);
    output.extend_from_slice(&[0xff, 0xfe]);
    output.extend_from_slice(&((MARKER_BYTES.len() + 2) as u16).to_be_bytes());
    output.extend_from_slice(MARKER_BYTES);
    output.extend_from_slice(&bytes[insert_at..]);
    output
}

fn add_webp_chunk_marker(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() < 12 {
        return None;
    }

    let mut output = bytes.to_vec();
    output.extend_from_slice(b"TIMG");
    output.extend_from_slice(&(MARKER_BYTES.len() as u32).to_le_bytes());
    output.extend_from_slice(MARKER_BYTES);
    if MARKER_BYTES.len() % 2 == 1 {
        output.push(0);
    }
    let riff_size = (output.len() - 8) as u32;
    output[4..8].copy_from_slice(&riff_size.to_le_bytes());
    Some(output)
}

fn add_isobmff_free_marker(bytes: &[u8]) -> Vec<u8> {
    let mut output = bytes.to_vec();
    output.extend_from_slice(&((8 + MARKER_BYTES.len()) as u32).to_be_bytes());
    output.extend_from_slice(b"free");
    output.extend_from_slice(MARKER_BYTES);
    output
}

fn add_png_marker_and_chunks(
    bytes: &[u8],
    mut extra_chunks: Vec<PngChunk>,
) -> Result<Vec<u8>, MetadataError> {
    let mut chunks = parse_png_chunks(bytes)?;
    chunks.retain(|chunk| {
        !(chunk.kind == *b"tEXt"
            && text_keyword(&chunk.data)
                .map(|keyword| keyword == MARKER_KEYWORD)
                .unwrap_or(false))
    });

    let mut marker = Vec::new();
    marker.extend_from_slice(MARKER_KEYWORD.as_bytes());
    marker.push(0);
    marker.extend_from_slice(MARKER_VALUE.as_bytes());
    extra_chunks.push(PngChunk {
        kind: *b"tEXt",
        data: marker,
    });

    let mut output = PNG_SIGNATURE.to_vec();
    for chunk in chunks {
        if chunk.kind == *b"IEND" {
            for extra in extra_chunks.drain(..) {
                write_chunk(&mut output, &extra);
            }
        }
        write_chunk(&mut output, &chunk);
    }

    Ok(output)
}

fn extract_comfy_png_chunks(bytes: &[u8]) -> Result<Vec<PngChunk>, MetadataError> {
    if !is_png(bytes) {
        return Ok(Vec::new());
    }

    Ok(parse_png_chunks(bytes)?
        .into_iter()
        .filter(|chunk| matches!(&chunk.kind, b"tEXt" | b"iTXt" | b"zTXt"))
        .filter(|chunk| {
            text_keyword(&chunk.data)
                .map(|keyword| {
                    let keyword = keyword.to_ascii_lowercase();
                    matches!(keyword.as_str(), "prompt" | "workflow" | "parameters")
                })
                .unwrap_or(false)
        })
        .collect())
}

fn parse_png_chunks(bytes: &[u8]) -> Result<Vec<PngChunk>, MetadataError> {
    if !is_png(bytes) {
        return Err(MetadataError::InvalidPng);
    }

    let mut offset = PNG_SIGNATURE.len();
    let mut chunks = Vec::new();
    while offset + 12 <= bytes.len() {
        let length = u32::from_be_bytes(
            bytes[offset..offset + 4]
                .try_into()
                .map_err(|_| MetadataError::InvalidPng)?,
        ) as usize;
        let kind: [u8; 4] = bytes[offset + 4..offset + 8]
            .try_into()
            .map_err(|_| MetadataError::InvalidPng)?;
        let data_start = offset + 8;
        let data_end = data_start + length;
        let crc_end = data_end + 4;
        if crc_end > bytes.len() {
            return Err(MetadataError::InvalidPng);
        }

        chunks.push(PngChunk {
            kind,
            data: bytes[data_start..data_end].to_vec(),
        });
        offset = crc_end;
        if kind == *b"IEND" {
            break;
        }
    }

    Ok(chunks)
}

fn write_chunk(output: &mut Vec<u8>, chunk: &PngChunk) {
    output.extend_from_slice(&(chunk.data.len() as u32).to_be_bytes());
    output.extend_from_slice(&chunk.kind);
    output.extend_from_slice(&chunk.data);
    let mut crc_input = Vec::with_capacity(4 + chunk.data.len());
    crc_input.extend_from_slice(&chunk.kind);
    crc_input.extend_from_slice(&chunk.data);
    output.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

fn text_keyword(data: &[u8]) -> Option<&str> {
    let end = data.iter().position(|byte| *byte == 0)?;
    std::str::from_utf8(&data[..end]).ok()
}

fn is_png_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("png"))
        .unwrap_or(false)
}

fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(PNG_SIGNATURE)
}

fn is_jpeg(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xff, 0xd8])
}

fn is_webp(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
}

fn looks_like_avif(bytes: &[u8]) -> bool {
    bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && bytes[8..]
            .windows(4)
            .take(8)
            .any(|window| window == b"avif" || window == b"avis")
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

#[derive(Debug, thiserror::Error)]
pub enum MetadataError {
    #[error("File system error: {0}")]
    Io(#[from] io::Error),
    #[error("Invalid PNG metadata")]
    InvalidPng,
}

impl From<MetadataError> for crate::files::FileError {
    fn from(value: MetadataError) -> Self {
        match value {
            MetadataError::Io(error) => crate::files::FileError::Io(error),
            MetadataError::InvalidPng => crate::files::FileError::InvalidPng,
        }
    }
}

#[allow(dead_code)]
fn _keep_pathbuf(_: PathBuf) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_with_text(keyword: &str, value: &str) -> Vec<u8> {
        let mut output = PNG_SIGNATURE.to_vec();
        output.extend_from_slice(&[0, 0, 0, 13]);
        output.extend_from_slice(b"IHDR");
        output.extend_from_slice(&[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
        output.extend_from_slice(
            &crc32(&[b"IHDR".as_slice(), &[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]].concat())
                .to_be_bytes(),
        );
        let mut data = Vec::new();
        data.extend_from_slice(keyword.as_bytes());
        data.push(0);
        data.extend_from_slice(value.as_bytes());
        write_chunk(
            &mut output,
            &PngChunk {
                kind: *b"tEXt",
                data,
            },
        );
        write_chunk(
            &mut output,
            &PngChunk {
                kind: *b"IEND",
                data: Vec::new(),
            },
        );
        output
    }

    #[test]
    fn marks_png_as_compressed() {
        let png = png_with_text("workflow", "{}");
        let marked = add_png_marker_and_chunks(&png, Vec::new()).unwrap();
        assert!(is_marked_compressed(&marked));
    }

    #[test]
    fn extracts_comfy_workflow_chunks() {
        let png = png_with_text("workflow", "{\"nodes\":[]}");
        let chunks = extract_comfy_png_chunks(&png).unwrap();
        assert_eq!(chunks.len(), 1);
    }

    #[test]
    fn marks_non_png_with_footer() {
        let bytes = add_footer_marker(b"unknown-format");
        assert!(is_marked_compressed(&bytes));
    }

    #[test]
    fn inserts_jpeg_comment_marker_before_eoi() {
        let marked = add_binary_marker(&[0xff, 0xd8, 1, 2, 0xff, 0xd9]);
        assert!(is_marked_compressed(&marked));
        assert!(marked.ends_with(&[0xff, 0xd9]));
    }

    #[test]
    fn updates_webp_riff_size_for_marker_chunk() {
        let webp = b"RIFF\x04\x00\x00\x00WEBP".to_vec();
        let marked = add_binary_marker(&webp);
        let riff_size = u32::from_le_bytes(marked[4..8].try_into().unwrap()) as usize;
        assert_eq!(riff_size, marked.len() - 8);
        assert!(is_marked_compressed(&marked));
    }
}
