// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Shared rules for keeping remote-support capabilities scoped to their chat turn. */
export class SupportSessionPolicy {
  private readonly internalFollowUpSources = new Set([
    'sub_agent_completion',
    'orchestrator_job_message',
    'agent_inbox',
  ]);

  shouldClearCapability(metadata: Record<string, unknown> | null | undefined): boolean {
    const source = typeof metadata?.source === 'string' ? metadata.source : '';
    return !this.internalFollowUpSources.has(source);
  }

  appendSupportContext(systemPrompt: string, context: unknown): string {
    if (typeof context !== 'string' || !context.trim()) return systemPrompt;
    return [systemPrompt.trim(), `<support_context>\n${ context.trim() }\n</support_context>`].filter(Boolean).join('\n\n');
  }

  toolRefusalReason(sessionId: string, allowedToolNames: unknown, toolName: string): string | null {
    if (!sessionId) return 'This chat is not attached to a support session.';
    if (!Array.isArray(allowedToolNames) || !allowedToolNames.includes(toolName)) {
      return 'This support tool is not allowed in this session.';
    }
    return null;
  }
}
