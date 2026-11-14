// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { REPLY_FORMAT_CONTENT } from '@pkg/agent/prompts/sections/replyFormat';
import { replySectionKind, structureReply } from '@pkg/pages/chat/messages/replyStructure';

function sections(html: string): { kind: string; heading: string; text: string }[] {
  const host = document.createElement('div');

  host.innerHTML = structureReply(html);

  return Array.from(host.querySelectorAll('section.reply-section'), section => ({
    kind:    section.className.replace('reply-section reply-', ''),
    heading: section.querySelector('h2, h3')?.textContent ?? '',
    text:    section.textContent ?? '',
  }));
}

describe('structureReply', () => {
  // risk: a long report must split into scannable groups, each with only its own content
  it('groups each heading with the content that follows it', () => {
    const result = sections(
      '<p>Intro.</p><h2>Summary</h2><p>Shipped.</p><h2>Issues found</h2><ul><li>x</li></ul><h2>Next steps</h2><ol><li>y</li></ol>',
    );

    expect(result.map(s => s.kind)).toEqual(['summary', 'issues', 'next']);
    expect(result[0].text).toBe('SummaryShipped.');
    expect(result[1].text).toBe('Issues foundx');
  });

  it('leaves the intro paragraph outside any section and short replies untouched', () => {
    const html = '<p>Just a short answer.</p>';

    expect(structureReply(html)).toBe(html);
    expect(structureReply('<p>Intro.</p><h2>Done</h2><p>a</p>')).toMatch(/^<p class="reply-lead">Intro\.<\/p><section/);
  });

  it('falls back to ### sections when the reply has no ## headings', () => {
    expect(sections('<h3>Next steps</h3><p>a</p>').map(s => s.kind)).toEqual(['next']);
  });

  // risk: blockers must stand out from minor notes
  it('tags issue bullets by their bold severity', () => {
    const host = document.createElement('div');

    host.innerHTML = structureReply('<h2>Issues found</h2><ul><li><strong>Blocker</strong> build fails</li><li><strong>Note</strong> typo</li><li>plain</li></ul>');
    const items = Array.from(host.querySelectorAll('li'), li => li.className);

    expect(items).toEqual(['reply-issue reply-issue-blocker', 'reply-issue reply-issue-note', '']);
  });

  it('recognises common heading wordings and ignores leading emoji', () => {
    expect(replySectionKind('TL;DR')).toBe('summary');
    expect(replySectionKind('⚠️ Problems')).toBe('issues');
    expect(replySectionKind('Questions for you')).toBe('decisions');
    expect(replySectionKind("What's next")).toBe('next');
    expect(replySectionKind('Architecture')).toBe('other');
  });

  // risk: the prompt and renderer drift apart and the agent's headings stop being styled
  it('recognises every section heading the reply_format prompt asks for', () => {
    const headings = Array.from(REPLY_FORMAT_CONTENT.matchAll(/^## (.+)$/gm), m => m[1]).filter(h => h !== 'Reply Format');

    expect(headings.map(replySectionKind)).toEqual(['summary', 'done', 'issues', 'decisions', 'next']);
  });
});

describe('structureReply with bold-label replies', () => {
  // risk: agents that write "**Label:**" lines instead of headings still produce a wall of text
  it('turns standalone bold lines into section headings and groups what follows', () => {
    const result = sections('<p>Bottom line.</p><p><strong>What I checked:</strong></p><p><strong>Real run:</strong> 0 found.</p><p><strong>Next steps:</strong></p><ol><li>Open PRs</li></ol>');

    expect(result.map(s => s.kind)).toEqual(['other', 'next']);
    expect(result[0].heading).toBe('What I checked');
  });

  it('tags labeled rows, flags problem labels, and marks the lead line', () => {
    const host = document.createElement('div');

    host.innerHTML = structureReply('<p>Bottom line.</p><p><strong>Checks:</strong></p><p><strong>Real run:</strong> fine.</p><p><strong>Uninvoiced mismatch:</strong> fixed.</p>');
    const [lead, run, mismatch] = ['p:first-child', 'p.reply-labeled:not(.reply-flag)', 'p.reply-flag'].map(sel => host.querySelector(sel)?.textContent);

    expect(lead).toBe('Bottom line.');
    expect(run).toBe('Real run: fine.');
    expect(mismatch).toBe('Uninvoiced mismatch: fixed.');
  });

  it('flags bullets whose label names a problem', () => {
    const host = document.createElement('div');

    host.innerHTML = structureReply('<ul><li><strong>Restore:</strong> done.</li><li><strong>Uninvoiced mismatch:</strong> gone.</li></ul>');

    expect(Array.from(host.querySelectorAll('li'), li => li.className)).toEqual(['', 'reply-flag']);
  });

  it('leaves inline bold inside sentences alone', () => {
    const html = '<p>This is <strong>important</strong> but not a label.</p>';

    expect(structureReply(html)).toBe(html);
  });
});
