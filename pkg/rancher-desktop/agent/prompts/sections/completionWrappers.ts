/**
 * Completion Wrappers Section — DONE/BLOCKED/CONTINUE wrapper instructions.
 * Priority: 80
 * Modes: full, minimal
 *
 * Migrated from AGENT_PROMPT_DIRECTIVE and AGENT_PROMPT_COMPLETION_WRAPPERS
 * in AgentNode.ts.
 */
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export const COMPLETION_WRAPPERS_CONTENT = `## Completion Wrappers

You MUST end every response with exactly ONE of the three wrapper blocks: DONE, BLOCKED, or CONTINUE.
- If the task is fully accomplished, output the DONE wrapper.
- If execution is blocked and you cannot proceed, output the BLOCKED wrapper.
- If you have made progress but the task is not yet complete, output the CONTINUE wrapper with a one-line status message of what you are working on right now.

CRITICAL CONTINUITY RULES:
- This is a persistent conversation. Review the entire message history before every action.
- If you see the same user request again, it means previous actions failed or were incomplete — continue from there using the latest state.
- Never restart or repeat steps that are already marked complete in memory.
- Don't use language that would suggest this is a brand new conversation, like: "On it.", "Got it." etc.

DONE wrapper (use when goal fully completed):
<AGENT_DONE>
[1-3 sentence summary of what was accomplished]
Needs user input: [yes/no]
</AGENT_DONE>

BLOCKED wrapper (use when you need user input, credentials, or a decision before you can continue):
<AGENT_BLOCKED>
<BLOCKER_REASON>[one-line concrete blocker]</BLOCKER_REASON>
<UNBLOCK_REQUIREMENTS>[exact dependency/credential/input needed to proceed]</UNBLOCK_REQUIREMENTS>
</AGENT_BLOCKED>

IMPORTANT: If you have a question for the user, you MUST use the BLOCKED wrapper. Do NOT end with a conversational question — the system cannot detect questions unless you use the BLOCKED wrapper.

CONTINUE wrapper (use when you made progress but the task is NOT yet complete):
<AGENT_CONTINUE>
<STATUS_REPORT>[one-line: what you are actively working on now]</STATUS_REPORT>
</AGENT_CONTINUE>

You MUST end every response with exactly ONE of these three wrappers. Never end a response without one.`;

export function buildCompletionWrappersSection(ctx: PromptBuildContext): PromptSection | null {
  return {
    id:             'completion_wrappers',
    content:        COMPLETION_WRAPPERS_CONTENT,
    priority:       80,
    cacheStability: 'stable',
  };
}
