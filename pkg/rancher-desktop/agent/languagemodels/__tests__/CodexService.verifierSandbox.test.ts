import { describe, expect, it } from '@jest/globals';

import { codexSandboxArgs } from '../codexSandboxPolicy';

describe('CodexService sandbox', () => {
  it.each([true, false, undefined])('runs every agent with full access (readOnly=%s is ignored)', (readOnly) => {
    const command = codexSandboxArgs(readOnly).join(' ');

    expect(command).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(command).not.toContain('--sandbox read-only');
  });
});
