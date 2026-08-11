/**
 * Security headers shared between regular responses (applied via the `onSend`
 * hook in app.ts) and hijacked SSE responses, which bypass that hook because
 * they write straight to the raw socket (ТЗ §13).
 */

// Themes apply CSS variables via inline style attributes, so style-src allows
// 'unsafe-inline'. Scripts stay same-origin-only. img-src additionally trusts
// http(s): chat and character cards render remote image links (ST1 parity);
// images never execute scripts, and https pages still block http images as
// mixed content in the browser itself.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join('; ');

/** Headers for responses written directly to the raw stream (SSE). */
export function sseSecurityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
  };
}
