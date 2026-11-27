// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';
import type { ToolExecutionContext } from '../../tools/executionContext';
import type { ClerkEnvironment } from './ClerkEndpoints';

/** Stable request and principal digests used across the Decide approval wait. */
export class ClerkApprovalFingerprint {
  private static canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${ value.map(value => this.canonical(value)).join(',') }]`;
    return `{${ Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${ JSON.stringify(key) }:${ this.canonical(child) }`).join(',') }}`;
  }

  static request(input: { method: string; url: URL; body: unknown; environment: ClerkEnvironment; confirm: boolean; action?: string }): string {
    return createHash('sha256').update(this.canonical({
      method:      input.method,
      url:         input.url.toString(),
      body:        input.body ?? null,
      environment: input.environment,
      confirm:     input.confirm,
      action:      input.action ?? null,
    })).digest('base64url');
  }

  static identity(context: ToolExecutionContext, binding?: { taskIndex: number; generation: string }): string {
    return createHash('sha256').update(this.canonical({
      sub: context.sub, agentId: context.agent_id, podId: context.pod_id,
      orgId: context.org_id ?? null, threadId: context.thread_id ?? null, jobId: context.job_id ?? null,
      workflowExecutionId: context.workflow_execution_id ?? null, deviceId: context.device_id ?? null,
      binding: binding ?? null,
      groupIds: [...(context.group_ids ?? [])].sort(), scopes: [...(context.scopes ?? [])].sort(),
      credentialScope: context.credential_scope ?? null,
    })).digest('base64url');
  }
}
