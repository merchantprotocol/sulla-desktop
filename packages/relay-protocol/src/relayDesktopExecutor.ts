// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ToolDeadlinePolicy } from '../../runtime-protocol/src/toolDeadlinePolicy.js';
import { relayRequestFingerprint } from './relayProtocol.js';
import type { RelayError, RelayToolExecutionContext as ToolExecutionContext, RelayToolResult as ToolResult } from './relayProtocol.js';

export interface RelayDesktopExecutorOptions {
  relayUrl:        string;
  deviceId?:       string;
  serviceToken:    string;
  fetchImpl?:      typeof fetch;
  deadlinePolicy?: ToolDeadlinePolicy;
}

/** Server-side transport for forwarding desktop-local tools through the relay. */
export class RelayDesktopExecutor {
  private readonly fetchImpl: typeof fetch;
  private readonly deadlinePolicy: ToolDeadlinePolicy;

  constructor(private readonly options: RelayDesktopExecutorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.deadlinePolicy = options.deadlinePolicy ?? new ToolDeadlinePolicy();
  }

  async execute(
    ctx: ToolExecutionContext,
    category: string,
    tool: string,
    args: unknown,
    opts: { deadlineMs: number; operationTypes?: readonly string[] },
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const deadlineMs = Math.max(1, opts.deadlineMs);
    // Outlast the relay's own grace so the Desktop's detailed result (or timeout) wins the race.
    const timer = setTimeout(() => controller.abort(), deadlineMs + 2_000);
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
          body:   JSON.stringify({ ctx, args, deadlineMs, operationTypes: opts.operationTypes }),
          signal: controller.signal,
        },
      );
      const body = await response.json() as { result?: ToolResult; error?: RelayError };
      return this.toToolResult(response.status, response.ok, body);
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          success: false,
          error: {
            code: 'deadline_exceeded', message: 'Desktop tool call deadline exceeded',
            details: this.deadlinePolicy.timeoutDetails(tool, deadlineMs, Date.now() - startedAt, opts.operationTypes),
          },
        };
      }
      return {
        success: false,
        error:   { code: 'desktop_unavailable', message: error instanceof Error ? error.message : String(error) },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Retrieve a retained original result without redispatching the tool call. */
  async retrieveResult(
    ctx: ToolExecutionContext,
    category: string,
    tool: string,
    args: unknown,
  ): Promise<ToolResult> {
    const base = this.options.relayUrl.replace(/\/$/, '');
    const deviceId = ctx.device_id ?? this.options.deviceId;
    if (!deviceId) return { success: false, error: { code: 'desktop_unavailable', message: 'No Desktop device is assigned to this capability' } };
    const fingerprint = relayRequestFingerprint({ deviceId, userId: ctx.sub, ctx, category, tool, args });
    try {
      const response = await this.fetchImpl(
        `${ base }/v1/devices/${ encodeURIComponent(deviceId) }/tools/results/${ encodeURIComponent(ctx.request_id) }`,
        { method: 'GET', headers: { Authorization: `Bearer ${ this.options.serviceToken }`, 'X-Sulla-Request-Fingerprint': fingerprint } },
      );
      const body = await response.json() as { result?: ToolResult; error?: RelayError };
      return this.toToolResult(response.status, response.ok, body);
    } catch (error) {
      return { success: false, error: { code: 'desktop_unavailable', message: error instanceof Error ? error.message : String(error) } };
    }
  }

  private toToolResult(status: number, ok: boolean, body: { result?: ToolResult; error?: RelayError }): ToolResult {
    if (!ok || body.error) {
      const error = body.error ?? { code: 'INTERNAL' as const, message: `Relay returned HTTP ${ status }` };
      return {
        success: false,
        error:   { code: error.code.toLowerCase(), message: error.message, details: { ...(error.details && typeof error.details === 'object' ? error.details as object : {}), retryable: error.retryable === true } },
      };
    }
    if (!body.result) return { success: false, error: { code: 'invalid_response', message: 'Relay returned no tool result' } };
    return body.result;
  }
}
