import type { RelayError, RelayToolExecutionContext, RelayToolResult } from './relayProtocol';

export interface RelayDesktopExecutorOptions {
  relayUrl:     string;
  deviceId:     string;
  serviceToken: string;
  fetchImpl?:   typeof fetch;
}

/** Server-side DesktopExecutor transport. It is structurally compatible with the shared contract. */
export class RelayDesktopExecutor {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: RelayDesktopExecutorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(
    ctx: RelayToolExecutionContext,
    category: string,
    tool: string,
    args: unknown,
    opts: { deadlineMs: number },
  ): Promise<RelayToolResult> {
    const controller = new AbortController();
    const deadlineMs = Math.max(1, opts.deadlineMs);
    const timer = setTimeout(() => controller.abort(), deadlineMs + 250);
    try {
      const base = this.options.relayUrl.replace(/\/$/, '');
      const response = await this.fetchImpl(
        `${ base }/v1/devices/${ encodeURIComponent(this.options.deviceId) }/tools/${ encodeURIComponent(category) }/${ encodeURIComponent(tool) }`,
        {
          method:  'POST',
          headers: {
            Authorization:  `Bearer ${ this.options.serviceToken }`,
            'Content-Type': 'application/json',
          },
          body:   JSON.stringify({ ctx, args, deadlineMs }),
          signal: controller.signal,
        },
      );
      const body = await response.json() as { result?: RelayToolResult; error?: RelayError };
      if (!response.ok || body.error) {
        const error = body.error ?? { code: 'INTERNAL' as const, message: `Relay returned HTTP ${ response.status }` };
        return {
          success: false,
          error:   { code: error.code.toLowerCase(), message: error.message, details: { retryable: error.retryable === true } },
        };
      }
      if (!body.result) return { success: false, error: { code: 'invalid_response', message: 'Relay returned no tool result' } };
      return body.result;
    } catch (error) {
      if (controller.signal.aborted) {
        return { success: false, error: { code: 'deadline_exceeded', message: 'Desktop tool call deadline exceeded' } };
      }
      return {
        success: false,
        error:   { code: 'desktop_unavailable', message: error instanceof Error ? error.message : String(error) },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
