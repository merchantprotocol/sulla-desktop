import { describe, expect, it } from '@jest/globals';

import { ClaudeCodeService } from '../ClaudeCodeService';
import { CodexService } from '../CodexService';

describe.each([
  ['Claude Code', () => new ClaudeCodeService()],
  ['Codex', () => new CodexService()],
])('%s resumed-turn assistant context', (_name, createService) => {
  it('replays contiguous synthetic assistant messages before the latest user message', () => {
    const service = createService();
    const messages: any[] = [
      { role: 'user', content: 'old user' },
      { role: 'assistant', content: 'old real answer' },
      {
        role: 'assistant',
        content: '<human_identity_context>\nidentity\n</human_identity_context>',
        metadata: { source: 'subconscious_context', _synthetic: true },
      },
      {
        role: 'assistant',
        content: '<project_report>\nwork\n</project_report>',
        metadata: { source: 'project_report', _synthetic: true },
      },
      { role: 'user', content: 'current user' },
    ];

    const text = (service as any).extractLatestUserMessage(messages);

    expect(text).toBe([
      'Assistant:\n<human_identity_context>\nidentity\n</human_identity_context>',
      'Assistant:\n<project_report>\nwork\n</project_report>',
      'User:\ncurrent user',
    ].join('\n\n'));
    expect(text).not.toContain('old real answer');
  });
});
