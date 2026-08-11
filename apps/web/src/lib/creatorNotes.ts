/**
 * Creator-notes HTML: sanitize + render into the character card preview.
 *
 * Security boundary (ARCH-14): creator notes may contain author-provided
 * HTML; it is sanitized here — extracted from the 1.7k-line
 * CharacterManagementPanel so the sanitization rules are reviewable and
 * unit-testable in isolation.
 */
import { renderMarkdownDocument } from './markdown.js';

/** Strip script/dangerous-embed markup and inline event/js handlers. */
export function sanitizeCreatorHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?\s*>/gi, '')
    .replace(/<\/?(?:base|iframe|object|embed|form)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(
      /\s(?:src|href)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi,
      '',
    );
}

/** Render creator notes (markdown + preserved safe HTML fragments). */
export function renderCreatorNotesDocument(value: string): string {
  const htmlFragments: string[] = [];
  const protectedSource = sanitizeCreatorHtml(value).replace(
    /<style\b[^>]*>[\s\S]*?<\/style\s*>|<\/?[a-z][^>]*>/gi,
    (fragment) => {
      const token = `@@character-html-${htmlFragments.length}@@`;
      htmlFragments.push(fragment);
      return isBlockHtmlFragment(fragment) ? `\n\n${token}\n\n` : token;
    },
  );
  const document = renderMarkdownDocument(protectedSource, {
    articleClass: 'character-card-markdown',
  });
  return htmlFragments.reduce((result, fragment, index) => {
    const token = `@@character-html-${index}@@`;
    return result.replace(`<p>${token}</p>`, fragment).replaceAll(token, fragment);
  }, document);
}

/** Standalone preview document (srcDoc for the preview iframe). */
export function createCreatorNotesPreviewDocument(value: string): string {
  const body = renderCreatorNotesDocument(value);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
    :root { color-scheme: light dark; }
    html { min-height: 100%; }
    body { min-height: 100%; margin: 0; color: CanvasText; background: Canvas; font: message-box; line-height: 1.55; overflow-wrap: anywhere; }
    img { max-width: 100%; height: auto; }
    a { color: LinkText; }
    pre { overflow-x: auto; white-space: pre-wrap; }
    .character-card-markdown { max-width: 72ch; margin: 0 auto; padding: 1.25rem; }
    .character-card-markdown > :first-child { margin-top: 0; }
    .character-card-markdown h1, .character-card-markdown h2 { line-height: 1.2; }
    .character-card-markdown blockquote { margin-inline: 0; padding-inline-start: 1rem; border-inline-start: 0.2rem solid currentColor; }
    .character-card-markdown code, .character-card-markdown pre { font-family: ui-monospace, monospace; }
    [data-character-preview-root] { display: flow-root; }
  </style></head><body><main data-character-preview-root>${body}</main></body></html>`;
}

/** Block-level tags that get paragraph isolation during markdown rendering. */
export function isBlockHtmlFragment(fragment: string): boolean {
  const tag = /^<\/?\s*([a-z0-9-]+)/i.exec(fragment)?.[1]?.toLowerCase();
  return (
    tag !== undefined &&
    new Set([
      'article',
      'aside',
      'blockquote',
      'div',
      'dl',
      'fieldset',
      'figcaption',
      'figure',
      'footer',
      'form',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'header',
      'hr',
      'main',
      'nav',
      'ol',
      'p',
      'pre',
      'section',
      'style',
      'table',
      'ul',
    ]).has(tag)
  );
}
