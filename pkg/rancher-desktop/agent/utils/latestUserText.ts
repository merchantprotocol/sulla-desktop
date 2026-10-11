/**
 * Text of the latest real user-role message: a human turn or a sub-agent /
 * agent-tab result wake. Skips subconscious-injected turns and tool-result-only
 * turns, and drops the per-turn <turn_context> block. '' when there is none.
 */
export function latestUserText(messages: any[] | undefined, maxChars = 2000): string {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i];
    if (message?.role !== 'user' || message?.metadata?.source === 'subconscious') continue;
    const text = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
        : '';
    const clean = text.replace(/<turn_context>[\s\S]*?<\/turn_context>/g, '').trim();
    if (clean) return clean.slice(0, maxChars);
  }
  return '';
}
