// The free-text message after the separator (DWA-MSG-*). It is for humans only: never parsed,
// never a matcher, never a target.

// Control, format (bidi overrides, zero-width), line and paragraph separators.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** DWA-MSG-002: replace unsafe characters with a space and trim. */
export function normalizeMessage(raw: string): string {
  return raw.replace(UNSAFE, ' ').trim();
}

/** Length in Unicode code points. */
export function codePointLength(text: string): number {
  // Array.from iterates by code point, which is what the limit counts (not grapheme clusters).
  return Array.from(text).length;
}

/** DWA-MSG-003: escape for any Slack text (stops mentions, `<!channel>` and link markup). */
export function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** DWA-MSG-005: plain text for the silence comment; no template syntax survives. */
export function commentSafe(text: string): string {
  return text.replace(/\{/g, '(').replace(/\}/g, ')').replace(/\$/g, '');
}

// Token shapes that must never reach a log line (DWA-AUD-001).
const TOKEN_SHAPES = /\b(?:xox[a-z]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+|glsa_[A-Za-z0-9_]+)/g;

export function redactTokenShapes(text: string): string {
  return text.replace(TOKEN_SHAPES, 'REDACTED');
}

export function hasTokenShape(text: string): boolean {
  TOKEN_SHAPES.lastIndex = 0;
  const found = TOKEN_SHAPES.test(text);
  TOKEN_SHAPES.lastIndex = 0;
  return found;
}
