// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Narration Policy Section — When and how to narrate tool call results.
 * Priority: 45
 * Modes: full
 *
 * Replaces the verbose "after every tool call, briefly say what you found"
 * directive from the old AGENT_PROMPT_DIRECTIVE.
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

const ANSWER_FIRST_FULL = `Respond before quiet work: when a human is reading, make your first output in a turn one short sentence. If you know the answer, give it; otherwise say what you're about to check.
Write it before any tool call; never open silently. For a greeting or tool-free question, just answer—skip "let me check" filler.
If asked to run something, one line saying you're running it is enough. Keep later narration brief.`;

const ANSWER_FIRST_LOCAL = `When a human is reading, start a turn with one short sentence before any tool call; never open silently.
Answer greetings and tool-free questions directly. For requested actions, one line saying what you're running is enough. Keep later narration brief.`;

const NARRATION_POLICY_BASE_CONTENT = `## Tool Result Narration

After tool calls, narrate results concisely to preserve context across conversation cycles. Your future self reads this to follow the conversation.

- Keep narration to one sentence per tool result.
- Focus on why you did it and what you found, not what you did: "Config at /path — db host is localhost:5432" not "I used read_file to read the config file."
- Skip narration for routine reads that produced expected results.
- Always narrate when: the result changes your plan, reveals something unexpected, or produced an error.`;

export const NARRATION_POLICY_CONTENT = `${ANSWER_FIRST_FULL}\n\n${NARRATION_POLICY_BASE_CONTENT}`;

const NARRATION_LOCAL_BASE_CONTENT = `## Narration
After tool calls, narrate results in one sentence. Focus on what was found, not what you did. Skip narration for expected results. Always narrate errors or surprises.`;

const NARRATION_LOCAL_CONTENT = `${ANSWER_FIRST_LOCAL}\n\n${NARRATION_LOCAL_BASE_CONTENT}`;

export function buildNarrationPolicySection(ctx: PromptBuildContext): PromptSection | null {
  if (ctx.mode !== 'full' && ctx.mode !== 'local') return null;

  // `isSubAgent` is fixed for the session, so this stable prompt gate preserves the existing delegated-job section.
  const content = ctx.isSubAgent
    ? (ctx.mode === 'local' ? NARRATION_LOCAL_BASE_CONTENT : NARRATION_POLICY_BASE_CONTENT)
    : (ctx.mode === 'local' ? NARRATION_LOCAL_CONTENT : NARRATION_POLICY_CONTENT);

  return {
    id:             'narration_policy',
    content,
    priority:       45,
    cacheStability: 'stable',
  };
}
