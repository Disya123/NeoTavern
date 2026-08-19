//! Synchronous Blitz `NetProvider` for `data:` URIs (Product Wire avatars).
//!
//! DummyNetProvider is a no-op, so `<img src="data:image/png;base64,…">` never
//! becomes a sampleable raster unless we decode the URI on fetch and complete
//! the handler before layout.

use base64::Engine;
use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request};

pub struct DataUriNetProvider;

/// Display avatars are downscaled before they reach `<img src>`. A leftover
/// original (Hazel ~2.2 MiB PNG as a data URI) must not enter decode.
const MAX_HREF_CHARS: usize = 96_000;

impl NetProvider for DataUriNetProvider {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let href = request.url.as_str();
        if href.len() > MAX_HREF_CHARS || !is_raster_data_uri(href) {
            // Packed CSS still has Phosphor `mask-image: url("data:image/svg+xml,…")`.
            // Completing those fetches made DummyNetProvider's no-op path paint,
            // and usvg/Vello then blacked the SurfaceView. Avatars are PNG/JPEG.
            return;
        }
        let href = href.to_string();
        let Some(bytes) = decode_data_uri(&href) else {
            return;
        };
        handler.bytes(href, Bytes::from(bytes));
    }
}

fn is_raster_data_uri(href: &str) -> bool {
    let Some(rest) = href.strip_prefix("data:") else {
        return false;
    };
    let meta = rest.split_once(',').map(|(m, _)| m).unwrap_or(rest);
    let mime = meta
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    matches!(
        mime.as_str(),
        "image/png" | "image/jpeg" | "image/jpg" | "image/webp" | "image/gif"
    )
}

pub fn decode_data_uri(href: &str) -> Option<Vec<u8>> {
    let rest = href.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    let compact: String = payload
        .chars()
        .filter(|ch| !ch.is_ascii_whitespace())
        .collect();
    if meta.contains("base64") {
        base64::engine::general_purpose::STANDARD
            .decode(compact.as_bytes())
            .ok()
    } else {
        Some(compact.into_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_data_uri, is_raster_data_uri};

    #[test]
    fn decodes_the_1x1_png_used_by_fake_wire() {
        let href = concat!(
            "data:image/png;base64,",
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        );
        let bytes = decode_data_uri(href).expect("png");
        assert!(bytes.starts_with(&[0x89, b'P', b'N', b'G']));
        assert!(is_raster_data_uri(href));
    }

    #[test]
    fn packed_phosphor_svg_masks_are_not_raster_fetches() {
        assert!(!is_raster_data_uri(
            "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E"
        ));
    }
}
