// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Groups a rendered reply into visual sections so long agent output reads as
 * a report instead of a wall of text. Each top-level heading and everything
 * after it, up to the next heading of that level, becomes a
 * <section class="reply-section reply-{kind}">. The kind comes from the
 * heading text, matching the names the reply_format prompt section asks for.
 * Issue bullets that open with a bold severity get a matching class.
 *
 * Input must already be sanitized HTML; this only regroups existing nodes.
 */

export type ReplySectionKind = 'summary' | 'done' | 'issues' | 'decisions' | 'next' | 'other';

const KINDS: [ReplySectionKind, RegExp][] = [
  ['summary', /^(summary|tl;?dr|conclusions?|results?|outcome|bottom line|status)\b/i],
  ['done', /^(done|completed|what (i )?(changed|did)|changes( made)?|progress|work done)\b/i],
  ['issues', /^(issues?|problems?|blockers?|risks?|errors?|warnings?|findings|known issues|concerns)\b/i],
  ['decisions', /^(decisions?|questions?|open questions|needs? your (input|decision|call)|waiting on you)\b/i],
  ['next', /^(next( steps?)?|what'?s next|follow[- ]?ups?|to[- ]?dos?|action items|remaining( work)?)\b/i],
];

const SEVERITIES: [string, RegExp][] = [
  ['blocker', /^(blocker|critical|blocking)\b/i],
  ['problem', /^(problem|issue|bug|error|warning|high|medium)\b/i],
  ['note', /^(note|minor|low|info|nit)\b/i],
];

/** Labels that name a problem; such rows are highlighted wherever they appear. */
const PROBLEM_LABEL = /\b(issues?|problems?|bugs?|errors?|mismatch(es)?|blockers?|blocked|risks?|fail(s|ed|ing|ures?)?|warnings?|broken|regressions?|conflicts?)\b/i;
const MAX_LABEL_LENGTH = 60;

export function replySectionKind(heading: string): ReplySectionKind {
  const text = heading.replace(/^[^a-z0-9]+/i, '').trim();

  return KINDS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'other';
}

/** `<p><strong>Label:</strong></p>`, a bold line standing alone, as agents often write instead of headings. */
function standaloneLabel(node: Element): string | null {
  if (node.tagName !== 'P' || node.children.length !== 1) return null;
  const only = node.firstElementChild!;
  const text = node.textContent?.trim() ?? '';

  if (!['STRONG', 'B'].includes(only.tagName) || only.textContent?.trim() !== text) return null;
  if (!text || text.length > MAX_LABEL_LENGTH) return null;

  return text.replace(/:\s*$/, '');
}

/**
 * Agents frequently skip Markdown headings and write bold labels instead.
 * Promote standalone bold lines to headings so the reply can still be grouped,
 * and tag "**Label:** text" paragraphs as labeled rows.
 */
function normalizeLabels(root: DocumentFragment, doc: Document): void {
  // "- **Mismatch:** …" bullets get the same problem highlight as labeled paragraphs.
  root.querySelectorAll('li').forEach((item) => {
    const lead = item.firstElementChild;
    const text = lead?.textContent?.trim() ?? '';

    if (lead && lead === item.firstChild && ['STRONG', 'B'].includes(lead.tagName) && text.endsWith(':') && PROBLEM_LABEL.test(text)) {
      item.classList.add('reply-flag');
    }
  });
  for (const node of Array.from(root.children)) {
    const label = standaloneLabel(node);

    if (label) {
      const heading = doc.createElement('h3');

      heading.textContent = label;
      heading.className = 'reply-label-heading';
      node.replaceWith(heading);
      continue;
    }
    const lead = node.firstChild;

    if (node.tagName === 'P' && lead instanceof doc.defaultView!.HTMLElement && ['STRONG', 'B'].includes(lead.tagName)) {
      const text = lead.textContent?.trim() ?? '';

      if (text.endsWith(':') && text.length <= MAX_LABEL_LENGTH) {
        node.classList.add('reply-labeled');
        if (PROBLEM_LABEL.test(text)) node.classList.add('reply-flag');
      }
    }
  }
}

function sectionLevel(root: DocumentFragment): 'H2' | 'H3' | null {
  const tags = Array.from(root.children, child => child.tagName);

  if (tags.includes('H2')) return 'H2';
  if (tags.includes('H3')) return 'H3';

  return null;
}

function markSeverities(section: Element): void {
  section.querySelectorAll(':scope > ul > li, :scope > ol > li').forEach((item) => {
    const lead = item.firstElementChild;

    if (!lead || lead !== item.firstChild || !['STRONG', 'B'].includes(lead.tagName)) return;
    const severity = SEVERITIES.find(([, pattern]) => pattern.test(lead.textContent?.trim() ?? ''))?.[0];

    if (severity) item.classList.add('reply-issue', `reply-issue-${ severity }`);
  });
}

export function structureReply(html: string, doc: Document = document): string {
  const template = doc.createElement('template');

  template.innerHTML = html;
  const root = template.content;

  normalizeLabels(root, doc);
  const level = sectionLevel(root);

  if (!level) return template.innerHTML;

  const nodes = Array.from(root.childNodes);
  let current: HTMLElement | null = null;

  for (const node of nodes) {
    if (node instanceof doc.defaultView!.HTMLElement && node.tagName === level) {
      const kind = replySectionKind(node.textContent ?? '');

      current = doc.createElement('section');
      current.className = `reply-section reply-${ kind }`;
      root.insertBefore(current, node);
    }
    if (current) current.appendChild(node);
  }

  root.querySelectorAll('section.reply-issues').forEach(markSeverities);
  // The opening line before the first section is the bottom line; give it weight.
  const first = root.firstElementChild;

  if (first?.tagName === 'P') first.classList.add('reply-lead');

  return template.innerHTML;
}
