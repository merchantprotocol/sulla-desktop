import DOMPurify from 'dompurify';
import { marked } from 'marked';

const ALLOWED_TAGS = [
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4',
  'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th',
  'thead', 'tr', 'ul',
];

const ALLOWED_ATTR = ['href', 'title'];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

/**
 * Render issue prose as Markdown (including trusted rich HTML), then reduce it
 * to the small Projects allowlist. If either parser encounters malformed
 * input, preserve a readable escaped plain-text rendering instead.
 */
export function renderProjectRichText(value: string | null | undefined): string {
  const source = String(value ?? '');
  if (!source.trim()) return '<p class="project-rich-empty">No content provided.</p>';

  try {
    const parsed = marked.parse(source, { async: false, breaks: true });
    const sanitized = DOMPurify.sanitize(parsed, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
    });
    return sanitized || `<pre>${ escapeHtml(source) }</pre>`;
  } catch {
    return `<pre>${ escapeHtml(source) }</pre>`;
  }
}
