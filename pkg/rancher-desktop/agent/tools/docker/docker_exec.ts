import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';

/**
 * Docker Exec Tool - Worker class for execution
 */
export class DockerExecWorker extends BaseTool {
  name = '';
  description = '';

  private formatFailure(container: string, res: { exitCode: number; stderr?: string; stdout?: string }): string {
    const details = (res.stderr || res.stdout || '').trim() || '(no stderr/stdout output)';
    return `Error executing command in container ${ container } (exit ${ res.exitCode }): ${ details }`;
  }

  private buildExecArgs(container: string, command: string): string[] {
    // Route through container shell so quoted values / spaces are preserved.
    return ['exec', container, 'sh', '-lc', command];
  }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { container, command } = input;

    const args = this.buildExecArgs(container, command);

    try {
      const res = await runCommand('docker', args, { timeoutMs: 60000, maxOutputChars: 160_000 });

      if (res.exitCode !== 0) {
        return {
          successBoolean: false,
          responseString: this.formatFailure(container, res),
        };
      }

      return {
        successBoolean: true,
        responseString: `Command executed in container ${ container }: ${ command }\nOutput:\n${ res.stdout }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error executing docker exec: ${ (error as Error).message }`,
      };
    }
  }
}
