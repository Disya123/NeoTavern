//! Local asset store serving decoded thumbnails to Blitz as `<img>` loads.
//!
//! Stage B of the image pipeline audit: images return to the scene as
//! `<img src="asset:{id}">`, and Blitz resolves the bytes through this
//! `NetProvider` instead of a network fetch. The store owns the rasters
//! (LRU + byte budget, §20 AGENTS); the producer seam registers it per
//! document via `LocalNetProvider`, so no global state crosses documents.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};

use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request};

/// URL scheme `<img>` elements carry for resolved assets. Re-exported from
/// the shell (the DOM builder owns the scheme).
pub use neotavern_presentation_dioxus_shell::ASSET_URL_PREFIX;

/// Bound the whole store: one entry is a ≤768px JPEG/PNG (message photo) or a
/// 192² PNG (avatar), so 32 MiB covers dozens of visible assets.
const STORE_MAX_BYTES: usize = 32 * 1024 * 1024;
const STORE_MAX_ENTRIES: usize = 64;

#[derive(Default)]
struct StoreInner {
    entries: Vec<(String, Arc<Vec<u8>>)>,
    order: VecDeque<String>,
    total_bytes: usize,
}

impl StoreInner {
    fn get(&mut self, id: &str) -> Option<Arc<Vec<u8>>> {
        let found = self
            .entries
            .iter()
            .find(|(key, _)| key == id)
            .map(|(_, bytes)| Arc::clone(bytes));
        if found.is_some() {
            self.touch(id);
        }
        found
    }

    fn touch(&mut self, id: &str) {
        if let Some(position) = self.order.iter().position(|key| key == id) {
            self.order.remove(position);
            self.order.push_back(id.to_string());
        }
    }

    fn insert(&mut self, id: &str, bytes: Vec<u8>) {
        if self.entries.iter().any(|(key, _)| key == id) {
            self.touch(id);
            return;
        }
        let need = bytes.len();
        self.evict_for(need);
        if self.total_bytes + need > STORE_MAX_BYTES || self.entries.len() >= STORE_MAX_ENTRIES {
            return;
        }
        self.entries.push((id.to_string(), Arc::new(bytes)));
        self.order.push_back(id.to_string());
        self.total_bytes += need;
    }

    fn evict_for(&mut self, need: usize) {
        while self.total_bytes + need > STORE_MAX_BYTES || self.entries.len() >= STORE_MAX_ENTRIES {
            let Some(evict_id) = self.order.pop_front() else {
                break;
            };
            if let Some(position) = self.entries.iter().position(|(key, _)| *key == evict_id) {
                let (_, bytes) = self.entries.remove(position);
                self.total_bytes = self.total_bytes.saturating_sub(bytes.len());
            }
        }
    }
}

/// Shared local raster store: asset id → encoded image bytes.
#[derive(Clone, Default)]
pub struct AssetStore {
    inner: Arc<Mutex<StoreInner>>,
}

impl AssetStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert (or refresh) an asset's raster. `id` must be non-empty; empty
    /// ids are ignored so a missing avatar degrades to the letter fallback.
    pub fn insert(&self, id: &str, bytes: Vec<u8>) {
        if id.is_empty() || bytes.is_empty() {
            return;
        }
        if let Ok(mut inner) = self.inner.lock() {
            inner.insert(id, bytes);
        }
    }

    pub fn contains(&self, id: &str) -> bool {
        self.inner
            .lock()
            .map(|mut inner| inner.get(id).is_some())
            .unwrap_or(false)
    }

    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .map(|inner| inner.entries.len())
            .unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Total bytes currently held (diagnostics/limits).
    pub fn total_bytes(&self) -> usize {
        self.inner
            .lock()
            .map(|inner| inner.total_bytes)
            .unwrap_or(0)
    }
}

/// Process-wide store the product produce seam registers with
/// [`LocalNetProvider`]. One store per process (documents are rebuilt per
/// produce but share decoded thumbnails); every handle is a cheap clone.
pub fn global_asset_store() -> AssetStore {
    static GLOBAL: OnceLock<AssetStore> = OnceLock::new();
    GLOBAL.get_or_init(AssetStore::new).clone()
}

/// `NetProvider` that resolves `asset:{id}` against an [`AssetStore`] and
/// falls through to `data:` URI decoding for any other raster href. SVG
/// mask-image hrefs stay untouched (packed CSS keeps them unresolved, same
/// contract as `DataUriNetProvider`).
pub struct LocalNetProvider {
    store: AssetStore,
}

impl LocalNetProvider {
    pub fn new(store: AssetStore) -> Self {
        Self { store }
    }
}

impl NetProvider for LocalNetProvider {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let href = request.url.as_str();
        if let Some(id) = href.strip_prefix(ASSET_URL_PREFIX) {
            if !id.is_empty() {
                if let Ok(mut inner) = self.store.inner.lock() {
                    if let Some(bytes) = inner.get(id) {
                        let bytes = bytes.as_ref().clone();
                        handler.bytes(href.to_string(), Bytes::from(bytes));
                        return;
                    }
                }
            }
            // Unknown asset id: leave the fetch unresolved so the `<img>`
            // keeps the letter fallback instead of painting an error.
            return;
        }
        super::data_uri::DataUriNetProvider.fetch(_doc_id, request, handler);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_inserts_and_evicts_lru() {
        let store = AssetStore::new();
        store.insert("a", vec![1u8; 8]);
        store.insert("b", vec![2u8; 8]);
        assert_eq!(store.len(), 2);
        assert!(store.contains("a"));
        assert_eq!(store.total_bytes(), 16);
        // Touch "a" so "b" becomes the LRU victim.
        assert!(store.contains("a"));
        store.insert("c", vec![3u8; 8]);
        assert_eq!(store.len(), 3);
        // Fill one past the entry cap: the oldest touched ("b") goes first.
        for index in 0..=(STORE_MAX_ENTRIES - 3) {
            store.insert(&format!("bulk-{index}"), vec![4u8; 8]);
        }
        assert_eq!(store.len(), STORE_MAX_ENTRIES);
        assert!(!store.contains("b"), "LRU victim evicted");
        assert!(store.contains("a"), "recently touched survives");
    }

    #[test]
    fn store_ignores_empty_ids_and_payloads() {
        let store = AssetStore::new();
        store.insert("", vec![1, 2, 3]);
        store.insert("x", Vec::new());
        assert!(store.is_empty());
    }

    #[test]
    fn store_reinsert_refreshes_without_duplicates() {
        let store = AssetStore::new();
        store.insert("a", vec![1u8; 4]);
        store.insert("a", vec![2u8; 6]);
        assert_eq!(store.len(), 1);
        assert_eq!(store.total_bytes(), 4, "existing entry keeps its bytes");
    }
}
