/**
 * Lightweight, sanitized Markdown → HTML for chat messages and character cards.
 * Escapes raw HTML first; supports ST1 roleplay formatting:
 * `"..."` dialogue quotes, `*emphasis*`, `**strong**`, `` `code` ``.
 */

const DEFAULT_ARTICLE_CLASS = 'chat-message-markdown';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderMarkdownDocument(value: string, options?: { articleClass?: string }): string {
  const articleClass = options?.articleClass ?? DEFAULT_ARTICLE_CLASS;
  const source = escapeHtml(value).replace(/\r\n?/g, '\n');
  const withHeadings = source
    .replace(/^######\s+(.+)$/gm, '<h6>$1</h6>')
    .replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>')
    .replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')
    .replace(/^---$/gm, '<hr>');
  const paragraphs = withHeadings
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      if (/^<h[1-6]>|^<hr>$/i.test(block)) return block;
      if (/^(?:[-*+]\s+.+\n?)+$/.test(block)) {
        return `<ul>${block
          .split('\n')
          .map((line) => `<li>${renderMarkdownInline(line.replace(/^[-*+]\s+/, ''))}</li>`)
          .join('')}</ul>`;
      }
      if (/^(?:\d+[.)]\s+.+\n?)+$/.test(block)) {
        return `<ol>${block
          .split('\n')
          .map((line) => `<li>${renderMarkdownInline(line.replace(/^\d+[.)]\s+/, ''))}</li>`)
          .join('')}</ol>`;
      }
      if (/^(?:&gt;\s?.+\n?)+$/.test(block)) {
        return `<blockquote>${renderMarkdownInline(block.replace(/^&gt;\s?/gm, '').replace(/\n/g, ' '))}</blockquote>`;
      }
      return `<p>${renderMarkdownInline(block.replace(/\n/g, '<br>'))}</p>`;
    })
    .join('');
  return `<article class="${articleClass}">${paragraphs}</article>`;
}

/**
 * Inline formatting order mirrors SillyTavern 1:
 * protect code → wrap dialogue quotes → strong → emphasis → media/links.
 */
export function renderMarkdownInline(value: string): string {
  const codeSpans: string[] = [];
  const withCodePlaceholders = value.replace(/`([^`]+)`/g, (_, code: string) => {
    const token = `@@md-code-${codeSpans.length}@@`;
    codeSpans.push(`<code data-part="message-code">${code}</code>`);
    return token;
  });

  // Pipe-delimited spans (ChatML tokens like `<|im_start|>`, table-ish prose)
  // are literal: without this, paired `_`/`*` inside them get consumed by the
  // emphasis/strong passes below and the token text is corrupted.
  const pipeSpans: string[] = [];
  const withPipesProtected = withCodePlaceholders.replace(
    /\|([^|\n]*)\|/g,
    (_, inner: string) => {
      const token = `@@md-pipe-${pipeSpans.length}@@`;
      pipeSpans.push(`|${inner}|`);
      return token;
    },
  );

  const withQuotes = wrapDialogueQuotes(withPipesProtected);

  const withMarks = withQuotes
    .replace(/\*\*([^*]+)\*\*/g, '<strong data-part="message-strong">$1</strong>')
    .replace(/__([^_]+)__/g, '<strong data-part="message-strong">$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em data-part="message-emphasis">$1</em>')
    .replace(/_([^_]+)_/g, '<em data-part="message-emphasis">$1</em>')
    .replace(
      /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
      '<img src="$2" alt="$1" loading="lazy" decoding="async" data-part="message-image" />',
    )
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer" data-part="message-link">$1</a>',
    );

  const withPipesRestored = pipeSpans.reduce(
    (result, text, index) => result.replace(`@@md-pipe-${index}@@`, text),
    withMarks,
  );
  return codeSpans.reduce(
    (result, html, index) => result.replace(`@@md-code-${index}@@`, html),
    withPipesRestored,
  );
}

/**
 * ST1 wraps paired dialogue quotes in `<q>` and keeps the quote glyphs visible.
 * Supports ASCII, curly, guillemets, corner brackets and fullwidth quotes.
 */
function wrapDialogueQuotes(value: string): string {
  return value.replace(
    /(&quot;.*?&quot;)|(\u201C.*?\u201D)|(\u00AB.*?\u00BB)|(\u300C.*?\u300D)|(\u300E.*?\u300F)|(\uFF02.*?\uFF02)/gim,
    (match) => `<q data-part="message-quote">${match}</q>`,
  );
}

/** Renders chat message content as sanitized HTML. */
export function renderChatMarkdown(value: string): string {
  return renderMarkdownDocument(value);
}
