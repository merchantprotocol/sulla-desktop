import { describe, expect, it, jest } from '@jest/globals';

// ClaudeCodeService's real imports drag in the Electron main-process world
// (MCP host, redis, logging, paths), which this suite never exercises —
// claimPrewarm only touches the in-memory pool. Stub them so the suite
// stays lightweight enough for constrained environments.
jest.mock('@pkg/main/MCPServerHost', () => ({ getMCPServerHost: jest.fn() }));
jest.mock('../../database/RedisClient', () => ({
  redisClient: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));
jest.mock('@pkg/utils/logging', () => {
  const noopLog = { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };

  return { __esModule: true, default: new Proxy({}, { get: () => noopLog }) };
});
jest.mock('@pkg/utils/paths', () => ({
  __esModule: true,
  default:    { limactl: '/dev/null', lima: '/dev/null', sullaHome: '/tmp', sullaConfig: '/tmp' },
}));

import { ClaudeCodeService } from '../ClaudeCodeService';

/**
 * Regression tests for warm-pool adoption. A parked/prewarmed process can
 * have output buffered while nobody was listening:
 *   - a prewarm that idled past the CLI's stdin wait emits an empty `result`,
 *     which used to instantly fail the adopting turn with "claude produced
 *     no output";
 *   - a buffered system/init line must survive adoption so the turn still
 *     captures its session id.
 */

function makeRecord(bufferedLines: string[]) {
  const chunks: (string | null)[] = bufferedLines.length ? [bufferedLines.join('\n')] : [];
  const proc = {
    stdout: { read: jest.fn(() => chunks.shift() ?? null) },
    kill:   jest.fn(),
  };

  return {
    proc,
    mcpSession:    null,
    mcpConfigPath: null,
    model:         'claude-code',
    createdAt:     Date.now(),
    closed:        false,
    busy:          false,
    reapTimer:     null,
  };
}

function claim(service: ClaudeCodeService, convId: string, record: ReturnType<typeof makeRecord>) {
  (service as any).prewarmed.set(convId, record);

  return (service as any).claimPrewarm(convId, 'claude-code');
}

describe('ClaudeCodeService.claimPrewarm', () => {
  it('declines a pooled process that buffered a stale result while unclaimed', () => {
    const service = new ClaudeCodeService();
    const record = makeRecord([
      JSON.stringify({ type: 'result', is_error: false, result: '' }),
    ]);

    const claimed = claim(service, 'conv-stale', record);

    expect(claimed).toBeNull();
    expect(record.proc.kill).toHaveBeenCalled();
  });

  it('keeps buffered non-result output for replay into the adopting turn', () => {
    const service = new ClaudeCodeService();
    const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    const record = makeRecord([initLine, '']);

    const claimed = claim(service, 'conv-init', record);

    expect(claimed).not.toBeNull();
    expect(claimed.pendingStdout).toContain('sess-1');
    expect(record.proc.kill).not.toHaveBeenCalled();
  });

  it('returns a clean record untouched when nothing was buffered', () => {
    const service = new ClaudeCodeService();
    const record = makeRecord([]);

    const claimed = claim(service, 'conv-clean', record);

    expect(claimed).not.toBeNull();
    expect(claimed.pendingStdout).toBeUndefined();
  });
});
