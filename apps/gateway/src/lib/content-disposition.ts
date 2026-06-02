/**
 * Build a Content-Disposition header value.
 *
 * RFC 6266 + RFC 5987:
 *   - Simple ASCII filenames (no spaces/quotes/special) → plain quoted form
 *   - Non-ASCII / spaces / special → filename*=UTF-8'' percent-encoded,
 *     with an ASCII fallback (filename="...") for legacy UAs
 *
 * @param disposition 'attachment' | 'inline'
 * @param filename The intended filename (UTF-8 string; may contain Chinese, emoji, etc.)
 */
export function buildContentDisposition(
  disposition: 'attachment' | 'inline',
  filename: string,
): string {
  const name = filename.length > 0 ? filename : 'download';

  // Simple ASCII fast path: only safe chars (letters, digits, ._-)
  if (/^[\x20-\x7E]+$/.test(name) && !/["\\]/.test(name)) {
    return `${disposition}; filename="${name}"`;
  }

  // RFC 5987: encode as UTF-8 + percent-escape
  const encoded = encodeRFC5987(name);

  // Build ASCII fallback by stripping non-ASCII and replacing unsafe chars
  const fallback = name
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_');

  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * RFC 5987 encoding: percent-escape everything except attr-char
 * (ALPHA / DIGIT / "!" / "#" / "$" / "&" / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~")
 */
function encodeRFC5987(s: string): string {
  return encodeURIComponent(s)
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A');
}
