// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ToolExecutionContext } from './executionContext.js';
import { ToolDeadlinePolicy } from './toolDeadlinePolicy.js';

export interface ToolResult {
  success: boolean;
  result?: unknown;
  error?:  { code: string; message: string; details?: unknown };
}

export interface DesktopExecutionOptions {
  deadlineMs: number;
  operationTypes?: readonly string[];
  /** Live agent proof for the private Clerk hop only. Never serialize with the tool arguments. */
  clerkToolSession?: string;
}

export interface DesktopExecutor {
  execute(ctx: ToolExecutionContext, category: string, tool: string, args: unknown, opts: DesktopExecutionOptions): Promise<ToolResult>;
}

export function toolRequestRejectionStatus(code: string | undefined): 400 | 409 | undefined {
  if (code === 'invalid_tool_input') return 400;
  if (code === 'task_inactive') return 409;
}

export class HttpDesktopExecutor implements DesktopExecutor {
  private readonly deadlinePolicy = new ToolDeadlinePolicy();

  constructor(private readonly endpoint: string, private readonly bearerToken: string,
    private readonly transport: typeof fetch = fetch) {}

  async execute(ctx: ToolExecutionContext, category: string, tool: string, args: unknown, opts: DesktopExecutionOptions): Promise<ToolResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.deadlineMs);
    try {
      const response = await this.transport(`${ this.endpoint.replace(/\/$/, '') }/internal/desktop-executor/${ encodeURIComponent(category) }/${ encodeURIComponent(tool) }`, {
        method:  'POST',
        headers: {
          'Content-Type':       'application/json',
          Authorization:        `Bearer ${ this.bearerToken }`,
          'X-Sulla-Request-Id': ctx.request_id,
          ...(category === 'clerk' && opts.clerkToolSession ? { 'X-Sulla-Tool-Session': opts.clerkToolSession } : {}),
        },
        ...(category === 'clerk' ? { redirect: 'error' as const } : {}),
        body:   JSON.stringify({ ctx, args, deadlineMs: opts.deadlineMs }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({ success: false, error: { code: 'invalid_response', message: `Desktop executor returned HTTP ${ response.status }` } }));
      if (!response.ok && body?.success !== false) return { success: false, error: { code: 'desktop_unavailable', message: `Desktop executor returned HTTP ${ response.status }` } };
      return body as ToolResult;
    } catch (error) {
      const timeoutHit = error instanceof Error && error.name === 'AbortError';
      return {
        success: false,
        error: {
          code: timeoutHit ? 'deadline_exceeded' : 'desktop_unavailable',
          message: timeoutHit ? 'Desktop executor deadline exceeded' : `Desktop executor unavailable: ${ error instanceof Error ? error.message : String(error) }`,
          ...(timeoutHit ? { details: this.deadlinePolicy.timeoutDetails(tool, opts.deadlineMs, opts.deadlineMs, opts.operationTypes) } : {}),
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
