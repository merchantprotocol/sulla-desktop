// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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

// Deliberately silent voice turn. The body is a private, short-lived note kept
// in graph history so the model can recognise the same overheard conversation
// on later turns. It must never reach the UI, TTS or relay; the agent saves
// the gist to memory itself.
const OVERHEARD_RE = /<overheard>([\s\S]*?)<\/overheard>/gi;

// Voice TTS tags (extracted earlier by BaseNode; strip if they leak through)
const SPEAK_RE = /<speak>([\s\S]*?)<\/speak>/gi;

// Workflow abort signal
const ABORT_WORKFLOW_RE = /<ABORT_WORKFLOW>([\s\S]*?)<\/ABORT_WORKFLOW>/gi;

// Citations block — extracted separately by CitationExtractor and surfaced as
// a CitationRow in the transcript; never shown as visible text.
const CITATIONS_RE = /<citations>([\s\S]*?)<\/citations>/gi;

const A2A_MARKER_RE = /⟦SULLA_A2A:([A-Za-z0-9_-]+)⟧/g;

/** Replace UI-only durable A2A card payloads with readable conversation text. */
export function a2aMarkersToText(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(A2A_MARKER_RE, (marker, encoded: string) => {
    try {
      const json = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const card = JSON.parse(json);
      const destination = `${card.to || 'agent'}${card.targetId ? `#${card.targetId}` : ''}`;
      return `[a2a → ${destination}: ${String(card.body || '')}]`;
    } catch { return marker; }
  });
}

/**
 * Some replies put the whole formatted answer inside a leading completion
 * wrapper. Keep that answer on display, not conventional trailing completion
 * metadata or short status-only wrappers. The strict control parser is unchanged.
 */
function unwrapFormattedDoneReply(text: string, streaming = false): string {
  const leading = /^\s*<AGENT_DONE>/i.exec(text);
  if (!leading) return text;
  const tail = text.slice(leading[0].length);
  const close = /<\/AGENT_DONE>/i.exec(tail);
  if (!streaming && !close) return text;
  let body = close ? tail.slice(0, close.index) : tail;
  if (!close) {
    const lastTag = body.lastIndexOf('</');
    if (lastTag >= 0 && '</agent_done>'.startsWith(body.slice(lastTag).toLowerCase())) body = body.slice(0, lastTag);
  }
  if (/<(?:overheard|AGENT_BLOCKED|AGENT_CONTINUE|ABORT_WORKFLOW|speak)\b/i.test(body)) return text;
  const prose = body.split(/<citations\b/i, 1)[0].trim();
  if (!/\r?\n[\t ]*\r?\n/.test(prose) || !/\*\*[^*\r\n]+\*\*/.test(prose) || !/`[^`\r\n]+`/.test(prose)) return text;
  return close ? body + tail.slice(close.index + close[0].length) : body;
}

/** Strip protocol wrappers for durable UI history without flattening A2A cards. */
export function stripProtocolTagsForUi(text: string | null | undefined): string {
  if (!text) return '';
  const markers: string[] = [];
  const preserved = unwrapFormattedDoneReply(text).replace(A2A_MARKER_RE, marker => `\u0000A2A${markers.push(marker) - 1}\u0000`);
  return stripProtocolTags(preserved).replace(/\u0000A2A(\d+)\u0000/g, (_placeholder, index: string) => markers[Number(index)] ?? '');
}


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
    .replace(OVERHEARD_RE, '')
    .replace(ABORT_WORKFLOW_RE, '')
    .replace(CITATIONS_RE, '')
    .replace(SPEAK_RE, '')
    .replace(KEY_RESULT_RE, '')
    .replace(BLOCKER_REASON_RE, '')
    .replace(UNBLOCK_REQUIREMENTS_RE, '')
    .replace(STATUS_REPORT_RE, '')
    .replace(STATUS_MESSAGE_RE, '')
    .replace(A2A_MARKER_RE, marker => a2aMarkersToText(marker))
    .trim();
}

/** Protocol tags that wrap the "end of turn" — everything after the opening
 *  tag is an internal control payload the user must never see. The opening
 *  tag alone is a complete signal to stop rendering, even before the close
 *  arrives. */
const PARTIAL_WRAPPER_START_RE = /<(AGENT_DONE|AGENT_BLOCKED|AGENT_CONTINUE|ABORT_WORKFLOW|overheard|speak|citations)\b/i;

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
  const cleaned = stripProtocolTags(unwrapFormattedDoneReply(text, true));
  const match = cleaned.match(PARTIAL_WRAPPER_START_RE);
  if (match) return cleaned.slice(0, match.index).trim();
  return holdBackPartialOpener(cleaned);
}

const WRAPPER_OPENERS = ['<agent_done', '<agent_blocked', '<agent_continue', '<abort_workflow', '<overheard', '<speak', '<citations'];

/** A flush can land mid-tag (`…answer. <AGE`). Emitting that and then the
 *  truncated `…answer.` on the next flush shrinks the stream, and consumers
 *  that only expect it to grow (mobile streaming TTS) restart the reply.
 *  Hold back a trailing fragment that could still become a wrapper opener. */
function holdBackPartialOpener(text: string): string {
  const lt = text.lastIndexOf('<');
  if (lt < 0) return text;
  const tail = text.slice(lt).toLowerCase();
  if (/\s/.test(tail)) return text;
  const partial = WRAPPER_OPENERS.some(opener => opener.startsWith(tail) || (opener === '<channel:' && tail.startsWith(opener)));
  return partial ? text.slice(0, lt).trim() : text;
}

/** True when a model response deliberately represents an overheard, silent turn. */
export function isOverheardProtocolTurn(text: string | null | undefined): boolean {
  if (!text) return false;
  OVERHEARD_RE.lastIndex = 0;
  return OVERHEARD_RE.test(text);
}
