import { estimateMessagesTokens, prepareProviderMessages } from '../contextBudget';

describe('context budget', () => {
  it('compacts large tool results without breaking tool pairs', () => {
    const messages: any[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'run the tool' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(10_000) }] },
      { role: 'user', content: 'continue' },
    ];
    const result = prepareProviderMessages(messages, 128_000);
    expect(result.messages).toHaveLength(5);
    expect(JSON.stringify(result.messages)).toContain('tool result compacted');
    expect(result.afterChars).toBeLessThan(result.beforeChars);
  });

  it('bounds a 40+ tool-loop transcript while preserving complete pairs', () => {
    const messages: any[] = [{ role: 'system', content: 's'.repeat(20_000) }];
    for (let i = 0; i < 45; i++) {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${ i }`, name: 'tool', input: {} }] });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${ i }`, content: 'result '.repeat(1_500) }] });
    }
    messages.push({ role: 'user', content: 'final request' });
    const result = prepareProviderMessages(messages, 16_000);
    expect(result.afterTokens).toBeLessThanOrEqual(result.inputBudgetTokens + estimateMessagesTokens(result.messages.slice(-1)));
    for (let i = 0; i < result.messages.length; i++) {
      const message = result.messages[i];
      if (message.role === 'assistant' && Array.isArray(message.content) && message.content[0]?.type === 'tool_use') {
        expect((result.messages[i + 1]?.content as any[])?.[0]?.type).toBe('tool_result');
      }
    }
  });
});
