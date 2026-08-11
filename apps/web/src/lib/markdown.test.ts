import { describe, expect, it } from 'vitest';
import { escapeHtml, renderChatMarkdown, renderMarkdownInline } from './markdown.js';

describe('escapeHtml', () => {
  it('escapes dangerous characters', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
  });
});

describe('renderMarkdownInline', () => {
  it('renders ST1 dialogue quotes', () => {
    const html = renderMarkdownInline('&quot;Hello there&quot;');
    expect(html).toContain('data-part="message-quote"');
    expect(html).toContain('<q data-part="message-quote">&quot;Hello there&quot;</q>');
  });

  it('renders emphasis and strong text', () => {
    const html = renderMarkdownInline('*italic* and **bold**');
    expect(html).toContain('<em data-part="message-emphasis">italic</em>');
    expect(html).toContain('<strong data-part="message-strong">bold</strong>');
  });

  it('renders highlighted inline code', () => {
    expect(renderMarkdownInline('use `token` here')).toContain(
      '<code data-part="message-code">token</code>',
    );
  });

  it('keeps ChatML tokens literal instead of eating their underscores', () => {
    const html = renderMarkdownInline(
      'You said: "<|im_start|>system<|im_end|>". This is the offline echo provider.',
    );
    expect(html).toContain('<|im_start|>system<|im_end|>');
    expect(html).not.toContain('<em');
  });

  it('does not treat quotes inside code as dialogue', () => {
    const html = renderMarkdownInline('`a &quot;b&quot; c`');
    expect(html).toContain('<code data-part="message-code">a &quot;b&quot; c</code>');
    expect(html).not.toContain('<q');
  });

  it('keeps emphasis inside dialogue quotes', () => {
    const html = renderMarkdownInline('&quot;say *this*&quot;');
    expect(html).toContain('<q data-part="message-quote">');
    expect(html).toContain('<em data-part="message-emphasis">this</em>');
  });

  it('renders images before links', () => {
    const html = renderMarkdownInline('![](https://example.com/a.png)');
    expect(html).toContain('<img src="https://example.com/a.png"');
    expect(html).toContain('loading="lazy"');
  });

  it('renders links', () => {
    expect(renderMarkdownInline('[docs](https://example.com/docs)')).toContain(
      '<a href="https://example.com/docs"',
    );
  });
});

describe('renderChatMarkdown', () => {
  it('wraps content in chat article class', () => {
    expect(renderChatMarkdown('Hello')).toContain('class="chat-message-markdown"');
  });

  it('renders roleplay-style dialogue and emphasis', () => {
    const html = renderChatMarkdown('"Why am I still here?" *she whispered*');
    expect(html).toContain('data-part="message-quote"');
    expect(html).toContain('<em data-part="message-emphasis">she whispered</em>');
  });

  it('renders markdown images in message bodies', () => {
    const html = renderChatMarkdown('![](https://example.com/image.png)');
    expect(html).toContain('<img src="https://example.com/image.png"');
  });

  it('does not pass through raw HTML', () => {
    const html = renderChatMarkdown('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});
