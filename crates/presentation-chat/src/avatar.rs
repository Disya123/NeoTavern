//! Display-sized avatar rasters for Blitz/Vello.
//!
//! Product Wire `assets.content` returns the original bytes. The Hazel starter
//! avatar is a 1024×1536 PNG (~2.2 MiB). Putting that in `<img src="data:…">`
//! makes Blitz `Url::join` / Vello image upload fail or leave the SurfaceView
//! uncleared (literal black). Header/card paint at 44–52 CSS px, so the DOM
//! only gets a downscaled PNG.

use base64::Engine;
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, ImageReader};
use std::io::Cursor;

/// Longest side for a header (44px) / card (52px) avatar at density 3.
pub const AVATAR_DISPLAY_MAX_PX: u32 = 192;

/// Reject data URIs that would still blow the Blitz/Vello path.
pub const AVATAR_DISPLAY_URI_MAX_CHARS: usize = 96_000;

pub fn display_avatar_data_uri(content_base64: &str) -> Option<String> {
    let compact: String = content_base64
        .chars()
        .filter(|ch| !ch.is_ascii_whitespace())
        .collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(compact.as_bytes())
        .ok()?;
    display_avatar_from_bytes(&bytes)
}

pub fn display_avatar_from_bytes(bytes: &[u8]) -> Option<String> {
    let image = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    let image = fit_display(image);
    let mut png = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .ok()?;
    if png.len() > AVATAR_DISPLAY_URI_MAX_CHARS {
        return None;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    let uri = format!("data:image/png;base64,{b64}");
    if uri.len() > AVATAR_DISPLAY_URI_MAX_CHARS {
        None
    } else {
        Some(uri)
    }
}

fn fit_display(image: DynamicImage) -> DynamicImage {
    if image.width() <= AVATAR_DISPLAY_MAX_PX && image.height() <= AVATAR_DISPLAY_MAX_PX {
        image
    } else {
        image.resize(
            AVATAR_DISPLAY_MAX_PX,
            AVATAR_DISPLAY_MAX_PX,
            FilterType::Triangle,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{display_avatar_from_bytes, AVATAR_DISPLAY_MAX_PX, AVATAR_DISPLAY_URI_MAX_CHARS};
    use base64::Engine;
    use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
    use std::io::Cursor;

    fn solid_png(width: u32, height: u32) -> Vec<u8> {
        let mut img = RgbaImage::new(width, height);
        for pixel in img.pixels_mut() {
            *pixel = Rgba([227, 138, 98, 255]);
        }
        let mut bytes = Vec::new();
        DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .expect("png");
        bytes
    }

    #[test]
    fn keeps_a_1x1_png_sampleable() {
        let png = solid_png(1, 1);
        let uri = display_avatar_from_bytes(&png).expect("uri");
        assert!(uri.starts_with("data:image/png;base64,"));
        assert!(uri.len() < AVATAR_DISPLAY_URI_MAX_CHARS);
    }

    #[test]
    fn downscales_a_1024_class_raster_for_the_dom() {
        let png = solid_png(1024, 768);
        let uri = display_avatar_from_bytes(&png).expect("uri");
        assert!(
            uri.len() < AVATAR_DISPLAY_URI_MAX_CHARS,
            "display uri still too large: {}",
            uri.len()
        );
        let b64 = uri
            .strip_prefix("data:image/png;base64,")
            .expect("prefix");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .expect("b64");
        let decoded = image::load_from_memory(&bytes).expect("decode");
        assert!(decoded.width() <= AVATAR_DISPLAY_MAX_PX);
        assert!(decoded.height() <= AVATAR_DISPLAY_MAX_PX);
    }
}
