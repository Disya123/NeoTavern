//! Display-sized premultiplied avatar thumbnails for the GPU overlay.
//!
//! Product Wire `assets.content` returns the original bytes. The Hazel starter
//! avatar is a 1024×1536 PNG (~2.2 MiB). Those bytes never enter Blitz as a
//! `data:` URI and never become a Vello `Image` brush. The compositor uploads a
//! cover-cropped 192×192 premultiplied RGBA thumbnail onto the same GPU
//! device/queue as NeoCompositor.

use base64::Engine;
use image::imageops::{crop_imm, FilterType};
use image::{DynamicImage, ImageReader, RgbaImage};
use std::io::Cursor;

/// Longest side for a header (44px) / card (52px) avatar at density 3.
pub const AVATAR_DISPLAY_MAX_PX: u32 = 192;

/// Reject leftover `data:` payloads. Not used on the paint path.
pub const AVATAR_DISPLAY_URI_MAX_CHARS: usize = 96_000;

// Decode preflight limits: a malicious `assets.content` must not be able to make
// the decoder allocate an unbounded raster. Dimensions are read from the image
// header (no pixel allocation) before any decode, and both the compressed input
// length and the decoded pixel count are bounded with checked arithmetic.
pub const THUMBNAIL_INPUT_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const THUMBNAIL_MAX_DIMENSION: u32 = 4096;
pub const THUMBNAIL_MAX_DECODED_PIXELS: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AvatarThumb {
    pub width: u32,
    pub height: u32,
    pub premul_rgba: Vec<u8>,
}

impl AvatarThumb {
    pub fn byte_len(&self) -> usize {
        self.premul_rgba.len()
    }
}

/// Reject inputs that would decode to an unbounded raster.
///
/// Reads only the image header (no pixel allocation) and bounds the compressed
/// length, each axis, and the decoded pixel count (checked multiply). Returns the
/// `(width, height)` so callers can also size their GPU upload without re-reading.
fn check_image_limits(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() > THUMBNAIL_INPUT_MAX_BYTES {
        return None;
    }
    let reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().ok()?;
    let (width, height) = reader.into_dimensions().ok()?;
    if width == 0 || height == 0 {
        return None;
    }
    if width > THUMBNAIL_MAX_DIMENSION || height > THUMBNAIL_MAX_DIMENSION {
        return None;
    }
    let pixels = u64::from(width).checked_mul(u64::from(height))?;
    if pixels > THUMBNAIL_MAX_DECODED_PIXELS {
        return None;
    }
    Some((width, height))
}

pub fn premultiplied_cover_thumbnail(content_base64: &str) -> Option<AvatarThumb> {
    let compact: String = content_base64
        .chars()
        .filter(|ch| !ch.is_ascii_whitespace())
        .collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(compact.as_bytes())
        .ok()?;
    thumbnail_from_bytes(&bytes)
}

pub fn thumbnail_from_bytes(bytes: &[u8]) -> Option<AvatarThumb> {
    let _dims = check_image_limits(bytes)?;
    let image = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    Some(cover_square_premul(image, AVATAR_DISPLAY_MAX_PX))
}

fn cover_square_premul(image: DynamicImage, size: u32) -> AvatarThumb {
    let size = size.max(1);
    let rgba = image.to_rgba8();
    let (width, height) = rgba.dimensions();
    let side = width.min(height).max(1);
    let x = (width.saturating_sub(side)) / 2;
    let y = (height.saturating_sub(side)) / 2;
    let cropped = crop_imm(&rgba, x, y, side, side).to_image();
    let resized = DynamicImage::ImageRgba8(cropped).resize_exact(size, size, FilterType::Triangle);
    let rgba = resized.to_rgba8();
    AvatarThumb {
        width: rgba.width(),
        height: rgba.height(),
        premul_rgba: premultiply(&rgba),
    }
}

fn premultiply(image: &RgbaImage) -> Vec<u8> {
    let mut out = Vec::with_capacity(image.len());
    for pixel in image.pixels() {
        let a = u16::from(pixel[3]);
        out.push(((u16::from(pixel[0]) * a + 127) / 255) as u8);
        out.push(((u16::from(pixel[1]) * a + 127) / 255) as u8);
        out.push(((u16::from(pixel[2]) * a + 127) / 255) as u8);
        out.push(pixel[3]);
    }
    out
}

/// Test helper only. Production paint never feeds this URI to Blitz/Vello.
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
    let thumb = thumbnail_from_bytes(bytes)?;
    let rgba = unpremultiply(&thumb.premul_rgba)?;
    let img = RgbaImage::from_raw(thumb.width, thumb.height, rgba)?;
    let mut png = Vec::new();
    DynamicImage::ImageRgba8(img)
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
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

fn unpremultiply(premul: &[u8]) -> Option<Vec<u8>> {
    if !premul.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(premul.len());
    for chunk in premul.chunks_exact(4) {
        let a = chunk[3];
        if a == 0 {
            out.extend_from_slice(&[0, 0, 0, 0]);
        } else {
            let scale = 255u16;
            out.push(((u16::from(chunk[0]) * scale) / u16::from(a)).min(255) as u8);
            out.push(((u16::from(chunk[1]) * scale) / u16::from(a)).min(255) as u8);
            out.push(((u16::from(chunk[2]) * scale) / u16::from(a)).min(255) as u8);
            out.push(a);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::{
        thumbnail_from_bytes, AvatarThumb, AVATAR_DISPLAY_MAX_PX, THUMBNAIL_INPUT_MAX_BYTES,
    };
    use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
    use std::io::Cursor;

    fn solid_png(width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
        let mut img = RgbaImage::new(width, height);
        for pixel in img.pixels_mut() {
            *pixel = Rgba(color);
        }
        let mut bytes = Vec::new();
        DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .expect("png");
        bytes
    }

    /// Build a PNG that declares `w`×`h` in its IHDR (CRC intentionally left
    /// stale). Used only to exercise the dimension preflight via the header reader.
    fn huge_dimensions_png(w: u32, h: u32) -> Vec<u8> {
        let mut v = solid_png(1, 1, [0, 0, 0, 255]);
        // IHDR width occupies bytes 16..20 and height 20..24 within the file.
        v[16..20].copy_from_slice(&w.to_be_bytes());
        v[20..24].copy_from_slice(&h.to_be_bytes());
        v
    }

    #[test]
    fn cover_crops_a_tall_raster_to_a_square_thumb() {
        let png = solid_png(1024, 1536, [227, 138, 98, 255]);
        let thumb = thumbnail_from_bytes(&png).expect("thumb");
        assert_eq!(thumb.width, AVATAR_DISPLAY_MAX_PX);
        assert_eq!(thumb.height, AVATAR_DISPLAY_MAX_PX);
        assert_eq!(
            thumb.premul_rgba.len(),
            (AVATAR_DISPLAY_MAX_PX * AVATAR_DISPLAY_MAX_PX * 4) as usize
        );
        assert_eq!(&thumb.premul_rgba[0..4], &[227, 138, 98, 255]);
    }

    #[test]
    fn premultiplies_partial_alpha() {
        let png = solid_png(4, 8, [200, 100, 50, 128]);
        let AvatarThumb { premul_rgba, .. } = thumbnail_from_bytes(&png).expect("thumb");
        let r = ((200u16 * 128 + 127) / 255) as u8;
        let g = ((100u16 * 128 + 127) / 255) as u8;
        let b = ((50u16 * 128 + 127) / 255) as u8;
        assert_eq!(&premul_rgba[0..4], &[r, g, b, 128]);
    }

    #[test]
    fn rejects_oversize_input_before_decode() {
        // 17 MiB of non-image bytes must be rejected by the length guard without
        // attempting a decode / allocation.
        let big = vec![0u8; THUMBNAIL_INPUT_MAX_BYTES + 1];
        assert!(thumbnail_from_bytes(&big).is_none());
    }

    #[test]
    fn rejects_huge_declared_dimensions() {
        // A PNG whose IHDR declares a 9000x9000 raster must be rejected by the
        // dimension / decoded-pixel guards (read from the header, no pixel decode).
        let png = huge_dimensions_png(9000, 9000);
        assert!(thumbnail_from_bytes(&png).is_none());
    }
}
