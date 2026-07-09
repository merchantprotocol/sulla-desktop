/**
 * Shared markdown rendering for chat message components.
 * marked + DOMPurify with the chat-safe allowlist (audio playback tags,
 * https/mailto/tel/file links, base64 image data URLs).
 */

import DOMPurify from 'dompurify';
import { marked } from 'marked';

export function renderMarkdown(markdown: string): string {
  const raw = typeof markdown === 'string' ? markdown : String(markdown || '');
  const html = (marked(raw) as string) || '';

  return DOMPurify.sanitize(html, {
    USE_PROFILES:       { html: true },
    ADD_TAGS:           ['audio', 'source'],
    ADD_ATTR:           ['controls', 'preload', 'src', 'type'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file):|data:image\/(?:png|gif|jpe?g|webp);base64,|\/|\.|#)/i,
  });
}
