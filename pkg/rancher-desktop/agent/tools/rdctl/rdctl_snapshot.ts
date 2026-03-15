import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Rdctl Snapshot Tool - Worker class for execution
 */
export class RdctlSnapshotWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { subcommand, args = [] } = input;

    const cmdArgs = ['snapshot', subcommand, ...args];

    try {
      const res = await runCommand('rdctl', cmdArgs, { timeoutMs: 120_000, maxOutputChars: 160_000 });

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Error executing snapshot command: ${ res.stderr || res.stdout }`,
        };
      }

      return {
        successBoolean: true,
        responseString: `Snapshot command executed: ${ subcommand }${ args.length ? ` ${ args.join(' ') }` : '' }\nOutput:\n${ res.stdout }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing rdctl snapshot: ${ (error as Error).message }`,
      };
    }
  }
}
