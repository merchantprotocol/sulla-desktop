// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Replying to a specific part of a Sulla message. The excerpt travels inside
 * the sent text as a leading Markdown quote, so every model and channel sees
 * exactly which chunk the user is answering, and the transcript can show it
 * as a quote block above the user's words.
 */

/** Longest excerpt kept; long blocks are cut at a word boundary. */
export const MAX_REPLY_EXCERPT = 600;

export function replyExcerpt(text: string, max = MAX_REPLY_EXCERPT): string {
  const clean = text.replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean).join('\n');
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');

  return `${ (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() }…`;
}

/** The text actually sent: the excerpt as a quote, a blank line, then the user's words. */
export function composeReply(excerpt: string, body: string): string {
  const quote = excerpt.split('\n').map(line => `> ${ line }`).join('\n');

  return body.trim() ? `${ quote }\n\n${ body.trim() }` : quote;
}

/** Splits a sent reply back into its quote and body; null when the text doesn't start with a quote. */
export function parseReply(text: string): { quote: string; body: string } | null {
  const lines = text.split('\n');
  let end = 0;

  while (end < lines.length && /^> ?/.test(lines[end])) end++;
  if (end === 0) return null;

  const quote = lines.slice(0, end).map(line => line.replace(/^> ?/, '')).join('\n').trim();
  const body = lines.slice(end).join('\n').trim();

  return quote ? { quote, body } : null;
}
