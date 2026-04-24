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

// Citations block — extracted separately by CitationExtractor and surfaced as
// a CitationRow in the transcript; never shown as visible text.
const CITATIONS_RE = /<citations>([\s\S]*?)<\/citations>/gi;

// Channel routing blocks — extracted by ChannelTagExtractor and dispatched
// over IPC to the target agent. Defense-in-depth strip so a straggler
// never leaks into user-visible content.
const CHANNEL_RE = /<channel:[\w.-]+>([\s\S]*?)<\/channel:[\w.-]+>/gi;

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
    .replace(CITATIONS_RE, '')
    .replace(CHANNEL_RE, '')
    .replace(SPEAK_RE, '')
    .replace(KEY_RESULT_RE, '')
    .replace(BLOCKER_REASON_RE, '')
    .replace(UNBLOCK_REQUIREMENTS_RE, '')
    .replace(STATUS_REPORT_RE, '')
    .replace(STATUS_MESSAGE_RE, '')
    .trim();
}

/** Protocol tags that wrap the "end of turn" — everything after the opening
 *  tag is an internal control payload the user must never see. The opening
 *  tag alone is a complete signal to stop rendering, even before the close
 *  arrives. */
const PARTIAL_WRAPPER_START_RE = /<(AGENT_DONE|AGENT_BLOCKED|AGENT_CONTINUE|ABORT_WORKFLOW|speak|citations|channel:[\w.-]+)\b/i;

/**
 * Streaming-aware strip. Runs the same pair-removal as `stripProtocolTags`
 * and additionally truncates the buffer at the first opening protocol tag,
 * even if its closing tag hasn't arrived yet.
 *
 * Rationale: the pair regexes (`<FOO>...</FOO>`) can't match a half-streamed
 * `<AGENT_DONE>\nsummary...` until the `</AGENT_DONE>` arrives. Without this
 * truncation the partial wrapper leaks into the streaming bubble — the user
 * sees `<AGENT_DONE` sitting below their response until the stream closes.
 * Once we see the opening tag, the rest of the buffer is definitionally
 * internal protocol; truncating it is safe and correct.
 */
export function stripProtocolTagsStreaming(text: string | null | undefined): string {
  if (!text) return '';
  const cleaned = stripProtocolTags(text);
  const match = cleaned.match(PARTIAL_WRAPPER_START_RE);
  if (!match) return cleaned;
  return cleaned.slice(0, match.index).trim();
}
