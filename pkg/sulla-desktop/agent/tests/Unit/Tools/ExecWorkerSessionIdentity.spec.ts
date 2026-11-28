// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  runCommand: vi.fn(),
  registerSession: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock('../../../tools/util/CommandRunner', () => ({ runCommand: f.runCommand }));
vi.mock('@pkg/main/MCPServerHost', () => ({
  getMCPServerHost: () => ({ running: true, registerSession: f.registerSession }),
}));

import { ExecWorker } from '@pkg/agent/tools/meta/exec';

describe('ExecWorker CLI session identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    f.registerSession.mockReturnValue({ id: 'child-session-token', revoke: f.revoke });
    f.runCommand.mockResolvedValue({ exitCode: 0, stdout: 'question saved', stderr: '' });
  });

  it('binds a delegated child CLI invocation to that child graph state', async() => {
    // risk: identity integrity — the CLI question must carry the child's session token so the route resolves the parent.
    const childState = { metadata: { threadId: 'child-thread', wsChannel: 'child-channel' } } as any;
    const worker = new ExecWorker();
    worker.setState(childState);

    const result = await (worker as any)._validatedCall({ command: "sulla meta/ask_user_question '{\"questions\":[]}'" });

    expect(result).toMatchObject({ successBoolean: true, responseString: 'question saved' });
    expect(f.registerSession).toHaveBeenCalledWith(childState, expect.any(Number));
    expect(f.runCommand).toHaveBeenCalledWith(
      expect.stringContaining("export SULLA_TOOL_SESSION='child-session-token'; sulla meta/ask_user_question"),
      [], expect.objectContaining({ runInGuest: true }),
    );
    expect(f.revoke).toHaveBeenCalledOnce();
  });
});
