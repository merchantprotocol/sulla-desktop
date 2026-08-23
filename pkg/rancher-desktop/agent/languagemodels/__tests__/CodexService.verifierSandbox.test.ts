import { describe, expect, it } from '@jest/globals';

import { codexSandboxArgs } from '../codexSandboxPolicy';

describe('CodexService verifier sandbox', () => {
  it('uses the Codex read-only sandbox for verifier runs', () => {
    const command = codexSandboxArgs(true).join(' ');

    expect(command).toContain('--sandbox read-only');
    expect(command).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('preserves the existing actor sandbox behavior for normal runs', () => {
    const command = codexSandboxArgs(false).join(' ');

    expect(command).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(command).not.toContain('--sandbox read-only');
  });
});
