/**
 * Turn Context — compact per-turn context block injected into the message
 * stream instead of the system prompt.
 *
 * The runtime line (current time), the live agent roster, and the voice-mode
 * directive all change between turns. When they lived in the system prompt's
 * dynamic tier they re-wrote the prompt every turn, which churned both the
 * Anthropic prompt-cache prefix and the claude-code stable-context hash.
 * They now travel as a small <turn_context> block appended to the latest
 * user message, so the system prompt stays byte-stable for the whole session.
 *
 * Keep this block SMALL — it is re-sent every turn and each send becomes
 * permanent conversation history. Target ~50-100 tokens.
 */

import type { ChatMode } from '../controllers/ChatController';

export interface TurnContextOptions {
  /** Agent identifier (e.g. 'sulla-desktop', 'dreaming-protocol') */
  agentId:     string;
  /** WebSocket channel the agent runs on */
  wsChannel:   string;
  /** Current chat mode — non-text modes add a condensed voice directive */
  chatMode:    ChatMode;
  /** Whether this is the heartbeat (autonomous) agent */
  isHeartbeat: boolean;
}

/** Matches a previously injected <turn_context> block (for idempotent replace). */
const TURN_CONTEXT_RE = /<turn_context>[\s\S]*?<\/turn_context>/gi;

/** Remove any <turn_context> block(s) from a string. */
export function stripTurnContext(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(TURN_CONTEXT_RE, '').trim();
}

/** True if the text contains a <turn_context> block. */
export function hasTurnContext(text: string | null | undefined): boolean {
  if (!text) return false;
  TURN_CONTEXT_RE.lastIndex = 0;
  return TURN_CONTEXT_RE.test(text);
}

// ─── Condensed voice-mode directives ────────────────────────────────────────
// Trimmed equivalents of prompts/voiceModes.ts — the full prompts no longer
// sit in the system prompt; these travel per turn only while a voice mode is
// active, so text-mode sessions pay nothing.

const VOICE_TURN_DIRECTIVE = 'voice mode: user is speaking via microphone. Wrap the spoken part of your reply in <speak>...</speak> — 1-3 short conversational sentences, no markdown/code/URLs inside the tags; details go in normal text outside them. For anything slow, give a brief <speak> ack and delegate via spawn_agent — never block the conversation.';

const SECRETARY_TURN_DIRECTIVE = `secretary mode: silently observe the meeting — never respond conversationally, never emit <speak>. Extract from the transcript and return exactly:
<secretary_analysis>
<actions>
- [decision/task/commitment + owner]
</actions>
<facts>
- [names, numbers, dates, IDs, technical details]
</facts>
<conclusions>
- [your inferences and follow-ups]
</conclusions>
</secretary_analysis>
Spawn a sub-agent (spawn_agent) for actionable lookups; do not wait for results.`;

const INTAKE_TURN_DIRECTIVE = 'intake mode: continuous voice intake — never emit <speak>, respond in ONE line, fast. If the chunk has actionable items (order/tracking numbers, scheduling, questions, tasks) spawn a sub-agent immediately via spawn_agent; otherwise acknowledge receipt. You are a dispatcher, not an executor.';

function voiceDirectiveFor(chatMode: ChatMode): string | null {
  switch (chatMode) {
  case 'voice':     return VOICE_TURN_DIRECTIVE;
  case 'secretary': return SECRETARY_TURN_DIRECTIVE;
  case 'intake':    return INTAKE_TURN_DIRECTIVE;
  default:          return null;
  }
}

// ─── Builder ─────────────────────────────────────────────────────────────────

/**
 * Build the <turn_context> block for the current turn.
 * Never throws — roster/presence failures degrade to the runtime line only.
 */
export async function buildTurnContext(opts: TurnContextOptions): Promise<string> {
  const lines: string[] = [];

  // Runtime line — replaces the former 'runtime' prompt section.
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
  const formattedTime = now.toLocaleString('en-US', {
    timeZone,
    weekday: 'short',
    year:    'numeric',
    month:   'short',
    day:     'numeric',
    hour:    '2-digit',
    minute:  '2-digit',
    hour12:  true,
  });
  const runtimeParts = [
    `now="${ formattedTime }"`,
    `tz=${ timeZone }`,
    `agent=${ opts.agentId || 'sulla-desktop' }`,
    `channel=${ opts.wsChannel || 'sulla-desktop' }`,
  ];
  if (opts.isHeartbeat) runtimeParts.push('heartbeat=autonomous-cycle');
  lines.push(runtimeParts.join(' '));

  // Live roster — replaces the dynamic half of the former 'channel_awareness'
  // section. The static messaging instructions stay in the stable prompt.
  try {
    const { getActiveAgentsRegistry } = await import('../services/ActiveAgentsRegistry');
    const roster = await getActiveAgentsRegistry().buildCompactRoster();
    if (roster) lines.push(roster);
  } catch { /* registry unavailable — runtime line still goes out */ }

  // Condensed voice directive — only while a voice mode is active.
  const voiceDirective = voiceDirectiveFor(opts.chatMode);
  if (voiceDirective) lines.push(voiceDirective);

  return `<turn_context>\n${ lines.join('\n') }\n</turn_context>`;
}
