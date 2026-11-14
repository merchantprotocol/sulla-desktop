// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Reply Format Section — how to lay out long replies to the user.
 * Priority: 46
 * Modes: full, local
 *
 * The chat renderer recognises these exact `##` headings and styles each
 * section (summary card, highlighted issues, next-step list), so the names
 * here must stay in sync with pages/chat/messages/replyStructure.ts.
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export const REPLY_FORMAT_CONTENT = `## Reply Format

Short answers (up to about five sentences) stay as plain prose. Any longer reply, such as a status update, a report on finished work or a review, MUST use these Markdown \`##\` headings (not bold labels), in this order, leaving out any that would be empty. The chat styles each heading below, so use them word for word:

\`\`\`markdown
## Summary
Two or three sentences: the outcome and where things stand.

## Done
What changed, as a bulleted list. Name files, branches, jobs or PRs in \`code\`.

## Issues found
One bullet per problem. Start each with **bold severity** (**Blocker**, **Problem** or **Note**), then what is wrong and its impact.

## Decisions needed
Questions only the user can answer, one per bullet, each answerable on its own.

## Next steps
A numbered list of what happens next and who does it.
\`\`\`

Rules: write the sections as normal Markdown, never inside a code block; put a blank line between paragraphs and around lists; keep bullets to one or two lines; never bury an issue or a question inside a paragraph; use \`###\` sub-headings only to group a long section.`;

const REPLY_FORMAT_LOCAL_CONTENT = `## Reply Format
Long replies use \`##\` sections in this order, skipping empty ones: Summary, Done, Issues found (each bullet starts with **Blocker**, **Problem** or **Note**), Decisions needed, Next steps (numbered). Short answers stay plain prose.`;

export function buildReplyFormatSection(ctx: PromptBuildContext): PromptSection | null {
  if (ctx.mode !== 'full' && ctx.mode !== 'local') return null;

  return {
    id:             'reply_format',
    content:        ctx.mode === 'local' ? REPLY_FORMAT_LOCAL_CONTENT : REPLY_FORMAT_CONTENT,
    priority:       46,
    cacheStability: 'stable',
  };
}
