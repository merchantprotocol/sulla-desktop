/**
 * stripProtocolTags — remove internal agent protocol XML wrappers from text.
 *
 * The agent is instructed to emit AGENT_DONE / AGENT_BLOCKED / AGENT_CONTINUE
 * wrappers as control signals.  These must NEVER leak into user-visible output,
 * stored conversation messages, or training data.
 *
 * This module is the single source of truth for the stripping regexes so every
 * code path that touches user-facing content can import it.
 */

// Outer wrappers
const AGENT_DONE_RE = /<AGENT_DONE>([\s\S]*?)<\/AGENT_DONE>/gi;
const AGENT_BLOCKED_RE = /<AGENT_BLOCKED>([\s\S]*?)<\/AGENT_BLOCKED>/gi;
const AGENT_CONTINUE_RE = /<AGENT_CONTINUE>([\s\S]*?)<\/AGENT_CONTINUE>/gi;

// Voice TTS tags (extracted earlier by BaseNode; strip if they leak through)
const SPEAK_RE = /<speak>([\s\S]*?)<\/speak>/gi;

// Workflow abort signal
const ABORT_WORKFLOW_RE = /<ABORT_WORKFLOW>([\s\S]*?)<\/ABORT_WORKFLOW>/gi;

// Inner tags (can appear standalone if the LLM partially formats)
const KEY_RESULT_RE = /<\/?KEY_RESULT>/gi;
const BLOCKER_REASON_RE = /<\/?BLOCKER_REASON>/gi;
const UNBLOCK_REQUIREMENTS_RE = /<\/?UNBLOCK_REQUIREMENTS>/gi;
const STATUS_REPORT_RE = /<\/?STATUS_REPORT>/gi;
const STATUS_MESSAGE_RE = /<\/?STATUS_MESSAGE>/gi;

/**
 * Strip all agent-protocol XML tags from a string.
 * Returns the cleaned text (trimmed).  If the input is falsy, returns ''.
 */
export function stripProtocolTags(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(AGENT_DONE_RE, '')
    .replace(AGENT_BLOCKED_RE, '')
    .replace(AGENT_CONTINUE_RE, '')
    .replace(ABORT_WORKFLOW_RE, '')
    .replace(SPEAK_RE, '')
    .replace(KEY_RESULT_RE, '')
    .replace(BLOCKER_REASON_RE, '')
    .replace(UNBLOCK_REQUIREMENTS_RE, '')
    .replace(STATUS_REPORT_RE, '')
    .replace(STATUS_MESSAGE_RE, '')
    .trim();
}
