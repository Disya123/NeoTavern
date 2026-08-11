import { describe, expect, it } from 'vitest';
import {
  createCreatorNotesPreviewDocument,
  isBlockHtmlFragment,
  renderCreatorNotesDocument,
  sanitizeCreatorHtml,
} from './creatorNotes.js';

describe('sanitizeCreatorHtml (ARCH-14 security boundary)', () => {
  it('removes script blocks and lone script tags', () => {
    expect(sanitizeCreatorHtml('<p>ok</p><script>alert(1)</script>')).not.toContain('script');
    expect(sanitizeCreatorHtml('before<script src="x"/>after')).not.toContain('script');
  });

  it('removes dangerous embed/redirect elements', () => {
    const dirty =
      '<iframe src="https://evil"></iframe><object data="x"></object><embed src="x"><form action="x"></form><base href="https://evil/">';
    const clean = sanitizeCreatorHtml(dirty);
    expect(clean).not.toMatch(/iframe|object|embed|form|base/i);
  });

  it('strips inline event handlers regardless of quoting', () => {
    expect(sanitizeCreatorHtml('<img src="x" onerror="alert(1)">')).not.toContain('onerror');
    expect(sanitizeCreatorHtml("<div ONCLICK='evil()'>x</div>")).not.toMatch(/onclick/i);
    expect(sanitizeCreatorHtml('<a href="#" onmouseover=alert(1)>x</a>')).not.toContain(
      'onmouseover',
    );
  });

  it('strips javascript: URLs from src/href', () => {
    expect(sanitizeCreatorHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');
    expect(sanitizeCreatorHtml("<img src=' javascript:evil()'>")).not.toContain('javascript:');
  });

  it('keeps safe markup intact', () => {
    const safe =
      '<h2>Title</h2><p>Text with <strong>bold</strong> and <a href="https://x">link</a></p>';
    expect(sanitizeCreatorHtml(safe)).toBe(safe);
  });
});

describe('renderCreatorNotesDocument', () => {
  it('renders markdown and preserves safe block HTML', () => {
    const html = renderCreatorNotesDocument('# Heading\n\n<div class="note">custom</div>\n\ntext');
    expect(html).toContain('Heading');
    // Block fragments survive sanitization/rendering; inner text is rendered
    // as markdown (wrapped in <p>).
    expect(html).toContain('<div class="note">');
    expect(html).toContain('custom');
  });

  it('sanitizes embedded HTML before rendering', () => {
    const html = renderCreatorNotesDocument('<div onclick="evil()">hi</div><script>bad()</script>');
    expect(html).not.toMatch(/onclick|script/i);
    expect(html).toContain('hi');
  });
});

describe('createCreatorNotesPreviewDocument', () => {
  it('wraps sanitized content in a standalone document', () => {
    const doc = createCreatorNotesPreviewDocument('hello <script>x()</script>');
    expect(doc).toContain('<!doctype html>');
    expect(doc).toContain('data-character-preview-root');
    expect(doc).not.toContain('script');
  });
});

describe('isBlockHtmlFragment', () => {
  it('detects block tags and rejects inline tags', () => {
    expect(isBlockHtmlFragment('<div>')).toBe(true);
    expect(isBlockHtmlFragment('</table>')).toBe(true);
    expect(isBlockHtmlFragment('<span>')).toBe(false);
    expect(isBlockHtmlFragment('<em class="x">')).toBe(false);
  });
});
