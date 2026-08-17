/**
 * Router / packaged-WebView detection for the bundled Android UI (M6).
 *
 * `file://` and the WebView Asset Loader host (`appassets.androidplatform.net`,
 * M-1 Track B) have no HTTP path space the SPA can own, so HashRouter is
 * required. The desktop/browser Vite origin keeps BrowserRouter (Playwright
 * and the sidecar Web Client). The Asset Loader host string is locked to the
 * Android `MeasurementOrigin.ASSET_LOADER_HOST` constant.
 */
import { isMobileShell } from './mobile.js';

/** Packaged Android (or any file-served) UI, not a `http(s)` origin. */
export function isPackagedWebView(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.location.protocol === 'file:' ||
    window.location.hostname === 'appassets.androidplatform.net'
  );
}

/** Hash history is required when the document URL is not an HTTP origin path. */
export function usesHashRouting(): boolean {
  return isMobileShell() || isPackagedWebView();
}
