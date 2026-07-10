import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';
import { HOST_ACCESS_DISABLED_MESSAGE, isHostAccessEnabled } from '../util/hostAccess';

/**
 * ExecHost — LAST RESORT shell on the host macOS machine (NOT the Lima VM).
 *
 * Everyday work must stay in the VM via the regular `exec` tool. The host
 * home directory is mounted into Lima at the same path, so project files,
 * installs, builds, tests, and sulla CLI calls do not need host execution.
 * Use this tool only when the parent host MUST be used (host-only
 * binaries/GUI apps, host Docker Desktop, tools unavailable in the VM, or
 * an explicit user request). Prefer reaching host services from the VM at
 * gateway IP 192.168.5.2 when that is enough.
 *
 * Uses the user's login shell so PATH includes Homebrew, nvm, rbenv, etc.
 * Gated by application.hostAccess (Preferences → Application →
 * Administrative Access → "Allow access to the host machine"). Fails
 * closed if that setting is off.
 *
 * Prefer this over the AppleScript→Terminal bridge when host execution is
 * truly required — no Terminal window pops up; output returns inline.
 */
export class ExecHostWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const command = String(input.command ?? input.cmd ?? '').trim();
    if (!command) {
      return { successBoolean: false, responseString: 'Missing required field: command (or cmd).' };
    }

    if (!await isHostAccessEnabled()) {
      return { successBoolean: false, responseString: HOST_ACCESS_DISABLED_MESSAGE };
    }

    const cwd       = input.cwd ? String(input.cwd).trim() : undefined;
    const timeoutMs = input.timeout ? Number(input.timeout) : 60_000;
    const stdin     = input.stdin ? String(input.stdin) : undefined;

    // Use the user's configured login shell so PATH includes Homebrew, nvm, etc.
    // Require an absolute path — process.env.SHELL is always /bin/zsh or /bin/bash
    // on macOS. Fall back to /bin/bash if SHELL is unset or a bare name.
    const shell = (process.env.SHELL ?? '').startsWith('/') ? process.env.SHELL! : '/bin/bash';

    // Prefix with cd when a working directory is requested.
    const script = cwd ? `cd ${ singleQuote(cwd) } && ${ command }` : command;

    try {
      // Passing the full path (e.g. /bin/zsh) bypasses CommandRunner's
      // special-case rewrite for bare "bash"/"zsh" names, so spawn receives
      // the args exactly as given: ['-lc', script].
      const res = await runCommand(shell, ['-lc', script], {
        timeoutMs,
        maxOutputChars: 160_000,
        stdin,
        // runInLimaShell is false by default → executes on the host process
      });

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Command exited ${ res.exitCode }:\n${ res.stderr || res.stdout }`,
        };
      }

      return {
        successBoolean: true,
        responseString: res.stdout || res.stderr || '(no output)',
      };
    } catch (err: any) {
      return { successBoolean: false, responseString: `exechost failed: ${ err.message }` };
    }
  }
}

/** Wrap a string in single quotes, escaping any embedded single quotes. */
function singleQuote(s: string): string {
  return `'${ s.replace(/'/g, `'"'"'`) }'`;
}
