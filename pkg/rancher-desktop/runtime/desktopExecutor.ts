import type { ToolExecutionContext } from '@pkg/agent/tools/executionContext';

export interface ToolResult {
  success: boolean;
  result?: unknown;
  error?:  { code: string; message: string; details?: unknown };
}

export interface DesktopExecutor {
  execute(ctx: ToolExecutionContext, category: string, tool: string, args: unknown, opts: { deadlineMs: number }): Promise<ToolResult>;
}

export class HttpDesktopExecutor implements DesktopExecutor {
  constructor(private readonly endpoint: string, private readonly bearerToken: string) {}

  async execute(ctx: ToolExecutionContext, category: string, tool: string, args: unknown, opts: { deadlineMs: number }): Promise<ToolResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.deadlineMs);
    try {
      const response = await fetch(`${ this.endpoint.replace(/\/$/, '') }/internal/desktop-executor/${ encodeURIComponent(category) }/${ encodeURIComponent(tool) }`, {
        method:  'POST',
        headers: {
          'Content-Type':       'application/json',
          Authorization:        `Bearer ${ this.bearerToken }`,
          'X-Sulla-Request-Id': ctx.request_id,
        },
        body:   JSON.stringify({ ctx, args, deadlineMs: opts.deadlineMs }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({ success: false, error: { code: 'invalid_response', message: `Desktop executor returned HTTP ${ response.status }` } }));
      if (!response.ok && body?.success !== false) return { success: false, error: { code: 'desktop_unavailable', message: `Desktop executor returned HTTP ${ response.status }` } };
      return body as ToolResult;
    } catch (error) {
      const timeoutHit = error instanceof Error && error.name === 'AbortError';
      return { success: false, error: { code: timeoutHit ? 'deadline_exceeded' : 'desktop_unavailable', message: timeoutHit ? 'Desktop executor deadline exceeded' : `Desktop executor unavailable: ${ error instanceof Error ? error.message : String(error) }` } };
    } finally {
      clearTimeout(timeout);
    }
  }
}
