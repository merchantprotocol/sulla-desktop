// SPDX-License-Identifier: GPL-2.0-or-later

/** Shipped names and the slugs older chats, jobs and manifests may still carry. */
export const BUILTIN_AGENT_RENAMES = [
  ['codex-luna-worker', 'quick-fixer', 'Codex LUNA Worker', 'Quick Fixer'],
  ['codex-sol-worker', 'builder', 'Codex SOL Worker', 'Builder'],
  ['sonnet-worker', 'generalist', 'Sonnet Worker', 'Generalist'],
  ['haiku-worker', 'lookup', 'Haiku Worker', 'Lookup'],
  ['opus-worker', 'advisor', 'Opus Worker', 'Advisor'],
  ['mockup-designer', 'designer', 'Mockup Designer', 'Designer'],
] as const;

export function newerBuiltinAgentSlug(slug: string): string | undefined {
  return BUILTIN_AGENT_RENAMES.find(([previous]) => previous === slug)?.[1];
}

/** Prefer the exact identity, including custom agents that own a colliding slug. */
export function findAgentBySlug<T extends { slug: string; isBuiltin?: boolean }>(agents: readonly T[], slug: string | null | undefined): T | undefined {
  const alias = slug ? newerBuiltinAgentSlug(slug) : undefined;
  return agents.find(agent => agent.slug === slug) ??
    (alias ? agents.find(agent => agent.isBuiltin && agent.slug === alias) : undefined);
}
