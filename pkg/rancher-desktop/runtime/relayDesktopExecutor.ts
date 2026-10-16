import type { ToolExecutionContext } from '@pkg/agent/tools/executionContext';

import type { DesktopExecutor, ToolResult } from './desktopExecutor';
import type { RelayError } from './relayProtocol';

export interface RelayDesktopExecutorOptions {
  relayUrl:     string;
  deviceId?:    string;
  serviceToken: string;
  fetchImpl?:   typeof fetch;
}

/** Server-side transport for forwarding desktop-local tools through the relay. */
export class RelayDesktopExecutor implements DesktopExecutor {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: RelayDesktopExecutorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(
    ctx: ToolExecutionContext,
    category: string,
    tool: string,
    args: unknown,
    opts: { deadlineMs: number },
  ): Promise<ToolResult> {
    const controller = new AbortController();
    const deadlineMs = Math.max(1, opts.deadlineMs);
    const timer = setTimeout(() => controller.abort(), deadlineMs + 250);
    try {
      const base = this.options.relayUrl.replace(/\/$/, '');
      const deviceId = ctx.device_id ?? this.options.deviceId;

      if (!deviceId) return { success: false, error: { code: 'desktop_unavailable', message: 'No Desktop device is assigned to this capability' } };
      const response = await this.fetchImpl(
        `${ base }/v1/devices/${ encodeURIComponent(deviceId) }/tools/${ encodeURIComponent(category) }/${ encodeURIComponent(tool) }`,
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
      const body = await response.json() as { result?: ToolResult; error?: RelayError };
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
