import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Exec Tool - Worker class for execution
 *
 * Commands run inside an isolated Lima VM, so destructive operations
 * (rm -rf, package installs, service management, etc.) are safe —
 * they cannot affect the host machine.
 */
export class ExecWorker extends BaseTool {
  name = '';
  description = '';

  schemaDef = {
    command:     { type: 'string' as const, optional: true, description: 'The exact shell command to run' },
    cmd:         { type: 'string' as const, optional: true, description: 'Alias for command' },
    description: { type: 'string' as const, optional: true, description: 'A short description of what this command does (e.g. "Install dependencies", "Check disk usage"). Displayed to the user.' },
    cwd:         { type: 'string' as const, optional: true, description: 'Working directory inside the VM to run the command in' },
    timeout:     { type: 'number' as const, optional: true, description: 'Timeout in milliseconds (default 120000). Use higher values for long-running installs.' },
    stdin:       { type: 'string' as const, optional: true, description: 'Optional stdin data to pipe into the command' },
  };

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const command = String(input.command ?? input.cmd ?? '').trim();

    if (!command) {
      return {
        successBoolean: false,
        responseString: 'Input validation failed: Missing required field: command (or cmd)',
      };
    }

    const cwd = input.cwd ? String(input.cwd).trim() : undefined;
    const timeoutMs = input.timeout ? Number(input.timeout) : 120_000;
    const stdin = input.stdin ? String(input.stdin) : undefined;

    // Prepend cd if a working directory was requested
    const finalCommand = cwd ? `cd ${ cwd } && ${ command }` : command;

    try {
      const res = await runCommand(finalCommand, [], {
        timeoutMs,
        maxOutputChars: 160_000,
        runInLimaShell: true,
        stdin,
      });

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Command failed with exit code ${ res.exitCode }:\n${ res.stderr || res.stdout }`,
        };
      }

      return {
        successBoolean: true,
        responseString: res.stdout || '(no output)',
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing command: ${ (error as Error).message }`,
      };
    }
  }
}
