import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../BaseLanguageModel', () => ({
  BaseLanguageModel: class {
    protected model = '';
  },
  FinishReason:    { Stop: 'stop' },
  usageTokenTotal: () => 0,
}));
jest.unstable_mockModule('@pkg/main/MCPServerHost', () => ({ getMCPServerHost: jest.fn() }));
jest.unstable_mockModule('../../database/RedisClient', () => ({
  redisClient: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));
jest.unstable_mockModule('@pkg/utils/logging', () => {
  const noopLog = { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };

  return { __esModule: true, default: new Proxy({}, { get: () => noopLog }) };
});
jest.unstable_mockModule('@pkg/utils/paths', () => ({
  __esModule: true,
  default:    { limactl: '/dev/null', lima: '/dev/null', sullaHome: '/tmp', sullaConfig: '/tmp' },
}));
jest.unstable_mockModule('../../services/WebSocketClientService', () => ({ getWebSocketClientService: jest.fn() }));
jest.unstable_mockModule('../../prompts/generateClaudeCodeMemoryFile', () => ({ generateClaudeCodeMemoryFile: async() => {} }));

const { ClaudeCodeService } = await import('../ClaudeCodeService');
const { CodexService } = await import('../CodexService');

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
        role:     'assistant',
        content:  '<human_identity_context>\nidentity\n</human_identity_context>',
        metadata: { source: 'subconscious_context', _synthetic: true },
      },
      {
        role:     'assistant',
        content:  '<project_report>\nwork\n</project_report>',
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
