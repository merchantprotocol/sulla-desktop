import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Lima Shell Tool - Worker class for execution
 */
export class LimaShellWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { instance, command } = input;

    const args = ['shell', instance];

    if (command) {
      args.push('--', command);
    }

    try {
      const res = await runCommand('limactl', args, { timeoutMs: command ? 60_000 : 300_000, maxOutputChars: 160_000 });

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Error executing command in Lima VM: ${ res.stderr || res.stdout }`,
        };
      }

      const responseString = `Command executed in Lima VM ${ instance }${ command ? `: ${ command }` : ' (interactive shell)' }\nOutput:\n${ res.stdout }`;

      return {
        successBoolean: true,
        responseString,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing limactl shell: ${ (error as Error).message }`,
      };
    }
  }
}
