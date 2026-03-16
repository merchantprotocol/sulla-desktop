import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Docker Rm Tool - Worker class for execution
 */
export class DockerRmWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { container, force } = input;

    const args = ['rm'];
    if (force) {
      args.push('-f');
    }
    args.push(container);

    try {
      const res = await runCommand('docker', args, { timeoutMs: 30000, maxOutputChars: 160_000 });

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Error removing docker container: ${ res.stderr || res.stdout }`,
        };
      }

      return {
        successBoolean: true,
        responseString: `Container removed successfully. Container: ${ container }${ force ? ' (force)' : '' }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing docker rm: ${ (error as Error).message }`,
      };
    }
  }
}
