import { describe, expect, it } from 'vitest';
import { VoiceAgentRouting } from './VoiceAgentRouting';

describe('VoiceAgentRouting', () => {
  const routing = new VoiceAgentRouting();

  it('routes voice to the fast voice agent, preserves an explicit agent, and leaves typed chat alone', () => {
    // risk: core business logic — voice turns must avoid the slow orchestrator without overriding user choice.
    expect(routing.resolve('voice')).toBe('conversationalist');
    expect(routing.resolve('voice', 'my-selected-agent')).toBe('my-selected-agent');
    expect(routing.resolve(undefined)).toBeUndefined();
  });
});
