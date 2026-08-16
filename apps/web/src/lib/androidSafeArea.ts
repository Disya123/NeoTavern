/**
 * Android WebView does not populate CSS `env(safe-area-inset-*)`. The host
 * publishes the box as CSS pixels through `window.__neotavernMobile.safeAreaCss()`.
 * The web client applies `--nt-inset-*` itself so chrome (headers, tabs, rail)
 * stays clear of the clock and gesture pill even when `evaluateJavascript`
 * races React hydration.
 */

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const CSS_PX = /^\d+(\.\d+)?px$/u;

type SafeAreaBox = Record<(typeof SIDES)[number], string>;

type SafeAreaBridge = {
  safeAreaCss?: () => string;
};

function readBridge(): SafeAreaBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { __neotavernMobile?: SafeAreaBridge }).__neotavernMobile;
}

function parseBox(raw: string): SafeAreaBox | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const box = {} as SafeAreaBox;
    for (const side of SIDES) {
      const value = record[side];
      if (typeof value !== 'string' || !CSS_PX.test(value)) return null;
      box[side] = value;
    }
    return box;
  } catch {
    return null;
  }
}

function lacksVerticalInsets(box: SafeAreaBox): boolean {
  return box.top === '0px' && box.bottom === '0px';
}

/** Apply the Android host's current safe-area box to `:root`. No-op off Android. */
export function applyAndroidSafeArea(): void {
  const css = readBridge()?.safeAreaCss?.();
  if (typeof css !== 'string') return;
  const box = parseBox(css);
  if (box === null) return;
  const root = document.documentElement;
  if (lacksVerticalInsets(box)) {
    // A cold WebView often reports 0,0,0,0 before WindowInsets. Writing that
    // box would clobber a later evaluateJavascript publish (and the Theme SDK
    // chrome would sit under the clock). Mobile chrome also has a 2xl floor.
    return;
  }
  for (const side of SIDES) {
    root.style.setProperty(`--nt-safe-area-${side}`, box[side], 'important');
    root.style.setProperty(`--nt-inset-${side}`, box[side], 'important');
  }
}

/**
 * Apply immediately, then retry so a cold WebView that still has 0-insets on
 * first JS can catch the first real WindowInsets dispatch.
 */
export function watchAndroidSafeArea(durationMs = 30_000, intervalMs = 250): () => void {
  applyAndroidSafeArea();
  if (readBridge()?.safeAreaCss === undefined) return () => undefined;
  const interval = window.setInterval(applyAndroidSafeArea, intervalMs);
  const timeout = window.setTimeout(() => window.clearInterval(interval), durationMs);
  const onResize = (): void => {
    applyAndroidSafeArea();
  };
  window.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
  return () => {
    window.clearInterval(interval);
    window.clearTimeout(timeout);
    window.removeEventListener('resize', onResize);
    window.visualViewport?.removeEventListener('resize', onResize);
  };
}
