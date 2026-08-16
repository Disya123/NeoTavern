/**
 * Shared conversation shell used by the Home preview (`/home`) and the live
 * chat (`/chats/:id`). It renders the wallpaper, the centred glass panel, and
 * the three themed slots — header, scrollable viewport and composer — so the
 * two routes are, by construction, the same surface. Pages supply header/
 * composer props (via {@link ChatHeader}/{@link ChatComposer}) and viewport
 * contents — submit and utility chrome stay inside ChatComposer so Send/Stop
 * and the utility row cannot drift. An empty or loading state should carry
 * `data-component="chat-state"` so it fills and centres itself inside the flex
 * viewport.
 *
 * `viewName` becomes the `data-component` on the root element (`home` or
 * `chat-view`); the e2e suite asserts `chat-view` on the live route.
 *
 * The header overlays the viewport (Telegram-style): identity controls are
 * padded with `--nt-inset-top` so they sit below the status bar, while
 * messages scroll under the translucent chrome.
 *
 * The root is a `<section>`, not a `<main>`: the single page landmark lives in
 * {@link AppShell} (`#chat-workspace`, the skip-link target). Rendering another
 * `<main>` here would create a nested/duplicate landmark.
 */
import type { CSSProperties, ReactNode, Ref } from 'react';
import styles from './ChatWorkspace.module.css';

export type ChatWorkspaceProps = {
  viewName: string;
  header: ReactNode;
  composer: ReactNode;
  viewportLabel?: string;
  /** Inline error shown beneath the composer (e.g. Home's chat-creation error). */
  footerError?: string;
  /**
   * Absolute URL of the per-chat wallpaper. When set it overrides the theme's
   * `chat-wallpaper-image` token for this surface via a scoped custom property;
   * when `null`/`undefined` the theme wallpaper (or its `none` fallback) is used.
   */
  wallpaperUrl?: string | null;
  /** Ref to the scrollable viewport (virtualized lists need it). */
  viewportRef?: Ref<HTMLDivElement>;
  children: ReactNode;
};

export function ChatWorkspace({
  viewName,
  header,
  composer,
  viewportLabel,
  footerError,
  wallpaperUrl,
  viewportRef,
  children,
}: ChatWorkspaceProps) {
  const wallpaperStyle =
    wallpaperUrl != null && wallpaperUrl.length > 0
      ? ({ '--st-chat-wallpaper-image': `url("${wallpaperUrl}")` } as CSSProperties)
      : undefined;
  return (
    <section className={styles.page} data-component={viewName} style={wallpaperStyle}>
      <div className={styles.wallpaper} data-part="chat-wallpaper" aria-hidden="true" />
      <div className={styles.workspace}>
        <div className={styles.chatPanel} data-component="chat-panel">
          {header}
          <div
            ref={viewportRef}
            className={styles.viewport}
            data-component="chat-viewport"
            data-part="canvas"
            aria-label={viewportLabel}
          >
            <div className={styles.scrollBody} data-part="chat-scroll">
              {children}
            </div>
            <div className={styles.composerWrapper} data-part="composer-sticky">
              {composer}
              {footerError ? (
                <div className={styles.footer}>
                  <p className={styles.footerError} role="alert">
                    {footerError}
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
