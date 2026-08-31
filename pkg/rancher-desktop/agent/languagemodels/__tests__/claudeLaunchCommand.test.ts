import { describe, expect, it } from '@jest/globals';

import { buildClaudeLaunchCommand } from '../claudeLaunchCommand';

describe('buildClaudeLaunchCommand', () => {
  it('falls back to launching Claude directly when stdbuf is unavailable', () => {
    const command = buildClaudeLaunchCommand(
      ["CLAUDE_CODE_OAUTH_TOKEN='oauth-token'"],
      ['claude', '-p', '--output-format', 'stream-json'],
    );

    expect(command).toContain('command -v stdbuf');
    expect(command).toContain('exec stdbuf -oL -eL claude');
    expect(command).toContain("else CLAUDE_CODE_OAUTH_TOKEN='oauth-token' exec claude -p");
  });
});
