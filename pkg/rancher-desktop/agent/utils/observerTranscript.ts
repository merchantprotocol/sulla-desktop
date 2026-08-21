/**
 * Convert agentic messages into a single plain-text observer transcript.
 * Structural tool_use/tool_result blocks are rendered as prose so an observer
 * cannot mistake the completed episode for a live actor session.
 */
function observerBlocksToText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);

  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') { if (b != null) parts.push(String(b)); continue }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'tool_use') {
      const input = b.input ? ` ${ JSON.stringify(b.input).slice(0, 300) }` : '';
      parts.push(`[called tool ${ b.name || 'unknown' }${ input }]`);
    } else if (b.type === 'tool_result') {
      const inner = typeof b.content === 'string'
        ? b.content
        : Array.isArray(b.content)
          ? b.content.map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : c?.type === 'image' ? '[image omitted]' : '')).filter(Boolean).join('\n')
          : JSON.stringify(b.content ?? '');
      parts.push(`[tool result] ${ inner }`);
    } else if (b.type === 'image') parts.push('[image omitted]');
    else parts.push(JSON.stringify(b));
  }
  return parts.join('\n');
}

// Keep recalled/injected context out of observer transcripts so writers do
// not record recalled rows again as fresh conversational evidence.
const INJECTED_CONTEXT_BLOCK_RE = /\n*<(observation_context|user_observations|self_observations|business_observations|world_observations|environment_observations|projects_observations|skills_observations|conversation_context|routine_digest|lane_health)>[\s\S]*?<\/\1>/g;

export function buildObserverTranscriptMessage(context: any[], userMessage: string): string {
  const lines: string[] = [];
  for (const m of context) {
    if (!m || m.role === 'system') continue;
    if (m?.metadata?.source === 'subconscious') continue;
    const who = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : (m.role || 'unknown');
    const text = observerBlocksToText(m.content).replace(INJECTED_CONTEXT_BLOCK_RE, '').trim();
    if (text) lines.push(`${ who }: ${ text }`);
  }
  const transcript = lines.join('\n\n') || '(no prior conversation)';
  return [
    'You are a silent OBSERVER of the conversation below. Your ONLY job is to analyze it and record memory through your provided database tools.',
    'You are NOT a participant. Do NOT continue the assistant\'s work, do NOT take any action the conversation describes, and do NOT read, write, or edit files, run commands, browse, or use source control. Only observe and record.',
    '',
    '=== BEGIN CONVERSATION TRANSCRIPT ===',
    transcript,
    '=== END CONVERSATION TRANSCRIPT ===',
    '',
    userMessage,
  ].join('\n');
}
