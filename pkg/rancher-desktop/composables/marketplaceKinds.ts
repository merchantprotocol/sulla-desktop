/** Marketplace kind contract shared by renderer, main, and agent tools. */
export const MARKETPLACE_KINDS = [
  { kind: 'package', aliases: [], label: 'Use Cases', singular: 'Use Case', icon: '📦', color: '#5096b3', desktopOnly: false, cloudInstallable: true },
  { kind: 'routine', aliases: ['workflow'], label: 'Workflows', singular: 'Workflow', icon: '⛓', color: '#5096b3', desktopOnly: false, cloudInstallable: true },
  { kind: 'agent', aliases: [], label: 'Agents', singular: 'Agent', icon: '🤖', color: '#8b7cf6', desktopOnly: true, cloudInstallable: false },
  { kind: 'skill', aliases: [], label: 'Skills', singular: 'Skill', icon: '✦', color: '#e0a84a', desktopOnly: false, cloudInstallable: true },
  { kind: 'function', aliases: [], label: 'Functions', singular: 'Function', icon: 'ƒ', color: '#4fb39a', desktopOnly: true, cloudInstallable: false },
  { kind: 'integration', aliases: [], label: 'Integrations', singular: 'Integration', icon: '🔌', color: '#d0708a', desktopOnly: true, cloudInstallable: false },
  { kind: 'recipe', aliases: [], label: 'Recipes', singular: 'Recipe', icon: '📦', color: '#8a94a6', desktopOnly: true, cloudInstallable: false },
] as const;

export type MarketplaceKind = typeof MARKETPLACE_KINDS[number]['kind'];
export type MarketplaceKindInput = MarketplaceKind | 'workflow';

export const MARKETPLACE_KIND_OPTIONS = [
  { value: 'all', label: 'All', icon: '', color: '' },
  ...MARKETPLACE_KINDS.map(({ kind, label, icon, color }) => ({ value: kind, label, icon, color })),
] as const;

export function normalizeMarketplaceKind(value: unknown): MarketplaceKind | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase().replace(/s$/, '') : '';
  if (raw === 'workflow' || raw === 'routine') return 'routine';

  return MARKETPLACE_KINDS.find(entry => entry.kind === raw)?.kind ?? null;
}

export function marketplaceKindInfo(value: unknown) {
  const kind = normalizeMarketplaceKind(value);

  return MARKETPLACE_KINDS.find(entry => entry.kind === kind) ?? null;
}

export function marketplaceKindLabel(value: unknown, plural = false): string {
  const info = marketplaceKindInfo(value);

  return info ? (plural ? info.label : info.singular) : String(value ?? '');
}
