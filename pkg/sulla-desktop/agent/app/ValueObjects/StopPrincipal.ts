// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export type StopPrincipalValue =
  | { kind: 'human' }
  | { kind: 'agent'; agentId: string; threadId: string }
  | { kind: 'system'; component: string };

export class StopPrincipal {
  static human(): StopPrincipalValue { return { kind: 'human' }; }

  static agent(agentId: unknown, threadId: unknown): StopPrincipalValue | undefined {
    const resolvedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
    const resolvedThreadId = typeof threadId === 'string' ? threadId.trim() : '';
    return resolvedAgentId && resolvedThreadId
      ? { kind: 'agent', agentId: resolvedAgentId, threadId: resolvedThreadId }
      : undefined;
  }

  static system(component: string): StopPrincipalValue { return { kind: 'system', component }; }

  static attribution(principal: StopPrincipalValue): { agentId: string; threadId: string } | { system: string } | 'human' {
    if (principal.kind === 'human') return 'human';
    if (principal.kind === 'system') return { system: principal.component };
    return { agentId: principal.agentId, threadId: principal.threadId };
  }
}
