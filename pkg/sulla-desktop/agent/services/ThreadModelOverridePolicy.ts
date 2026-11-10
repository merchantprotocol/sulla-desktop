// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type ThreadModelSelection =
  | { mode: 'default' }
  | { mode: 'explicit'; provider: string; model: string }
  | { mode: 'unchanged' };

/** Owns the wire-to-thread transition for the chat model picker. */
export class ThreadModelOverridePolicy {
  parse(metadata: Record<string, unknown> | null | undefined): ThreadModelSelection {
    if (metadata?.modelSelection === 'default') return { mode: 'default' };
    const provider = typeof metadata?.providerId === 'string' ? metadata.providerId.trim() : '';
    const model = typeof metadata?.modelId === 'string' ? metadata.modelId.trim() : '';
    return provider && model ? { mode: 'explicit', provider, model } : { mode: 'unchanged' };
  }

  apply(agent: Record<string, unknown> | null | undefined, selection: ThreadModelSelection): Record<string, unknown> | undefined {
    if (selection.mode === 'unchanged') return agent ?? undefined;
    if (selection.mode === 'explicit') return { ...(agent ?? {}), provider: selection.provider, model: selection.model };
    if (!agent) return undefined;
    const { provider: _provider, model: _model, ...withoutOverride } = agent;
    return withoutOverride;
  }
}
