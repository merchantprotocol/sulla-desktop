import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Docker Logs Tool - Worker class for execution
 */
export class DockerLogsWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { container, follow, tail } = input;

    const args = ['logs', container];
    if (follow) {
      args.push('-f');
    }
    if (tail !== undefined) {
      args.push('--tail', tail.toString());
    }

    try {
      const res = await runCommand('docker', args, { timeoutMs: follow ? 300000 : 30000, maxOutputChars: 160_000 });

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: `Error fetching logs for container ${ container }: ${ res.stderr || res.stdout }`,
        };
      }

      return {
        successBoolean: true,
        responseString: `Logs for container ${ container }${ follow ? ' (following)' : '' }${ tail ? ` (last ${ tail } lines)` : '' }:\n${ res.stdout }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing docker logs: ${ (error as Error).message }`,
      };
    }
  }
}
