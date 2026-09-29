import { describe, expect, it } from '@jest/globals';

import { buildClaudeLaunchCommand, buildRemoteKillCommand, newRemotePidFile } from '../claudeLaunchCommand';

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

  it('records the shell PID (kept by exec) in the pidfile before launching', () => {
    const command = buildClaudeLaunchCommand([], ['claude', '-p'], '/tmp/sulla-claude-abc.pid');

    expect(command.startsWith("echo $$ > '/tmp/sulla-claude-abc.pid'; if command -v stdbuf")).toBe(true);
  });

  it('omits the pidfile write when none is given', () => {
    expect(buildClaudeLaunchCommand([], ['claude', '-p'])).not.toContain('echo $$');
  });
});

describe('newRemotePidFile', () => {
  it('returns a unique /tmp path per spawn', () => {
    const a = newRemotePidFile();
    const b = newRemotePidFile();

    expect(a).toMatch(/^\/tmp\/sulla-claude-[a-z0-9]+\.pid$/);
    expect(a).not.toBe(b);
    expect(newRemotePidFile('sulla-codex')).toMatch(/^\/tmp\/sulla-codex-/);
  });
});

describe('buildRemoteKillCommand', () => {
  it('signals only the pid in the pidfile — never a VM-wide pkill', () => {
    const command = buildRemoteKillCommand('/tmp/sulla-claude-abc.pid', 'TERM');

    expect(command).toContain("p=$(cat '/tmp/sulla-claude-abc.pid' 2>/dev/null)");
    expect(command).toContain('kill -TERM "$p"');
    expect(command).not.toContain('pkill');
    expect(command).not.toContain('rm -f');
  });

  it('removes the pidfile on the final KILL and sweeps day-old pidfiles', () => {
    const command = buildRemoteKillCommand('/tmp/sulla-claude-abc.pid', 'KILL');

    expect(command).toContain('kill -KILL "$p"');
    expect(command).toContain("rm -f '/tmp/sulla-claude-abc.pid'");
    expect(command).toContain("find '/tmp' -maxdepth 1 -name 'sulla-claude-*.pid' -mmin +1440 -delete");
  });
});
