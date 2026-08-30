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
  const sanitized = DOMPurify.sanitize(html, {
    USE_PROFILES:       { html: true },
    ADD_TAGS:           ['audio', 'source'],
    ADD_ATTR:           ['controls', 'preload', 'src', 'type', 'target', 'rel'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file):|data:image\/(?:png|gif|jpe?g|webp);base64,|\/|\.|#)/i,
  });

  // Sulla's main BrowserWindow routes target=_blank navigations into an
  // in-app browser tab. Citation cards already opt into that path; Markdown
  // links must do the same or Electron leaves them in the chat renderer,
  // where navigation is intentionally suppressed.
  const container = document.createElement('template');

  container.innerHTML = sanitized;
  container.content.querySelectorAll('a[href]').forEach((anchor) => {
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
  });

  return container.innerHTML;
}
