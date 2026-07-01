import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';
import { HOST_ACCESS_DISABLED_MESSAGE, isHostAccessEnabled } from '../util/hostAccess';

/**
 * ExecHost — runs a shell command directly on the host macOS machine,
 * NOT inside the Lima VM. Uses the user's login shell so that PATH
 * includes Homebrew, nvm, rbenv, etc. — any tool the user has installed.
 *
 * Gated by application.hostAccess (Preferences → Application →
 * Administrative Access → "Allow access to the host machine"). Fails
 * closed if that setting is off.
 *
 * Use this instead of the AppleScript→Terminal bridge whenever you need
 * to run host commands silently — no Terminal window pops up, output is
 * returned directly to the agent.
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
