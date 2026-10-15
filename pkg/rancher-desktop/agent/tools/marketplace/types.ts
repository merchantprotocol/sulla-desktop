/**
 * Shared types and per-kind layout knowledge for the marketplace tool family.
 *
 * Each artifact kind has a different local directory and manifest file, but
 * the marketplace API treats them uniformly via `<kind>/<slug>` addressing.
 */

import { MARKETPLACE_KINDS, normalizeMarketplaceKind } from '@pkg/composables/marketplaceKinds';

export const ARTIFACT_KINDS = ['skill', 'function', 'workflow', 'agent', 'recipe', 'integration'] as const;
export type ArtifactKind = typeof ARTIFACT_KINDS[number];

export interface ArtifactLayout {
  /**
   * Filename of the primary manifest inside an artifact's directory.
   * For most kinds this is a literal filename (`function.yaml`).
   * For integrations it is `dynamic` — the filename is slug-dependent
   * (`<slug>.v<N>-auth.yaml`) and must be resolved at runtime via
   * {@link resolveArtifactManifestPath}.
   */
  manifest:         string | 'dynamic';
  /** Whether the artifact is a single-file or multi-file bundle. */
  bundle:           'single' | 'multi';
  /** Optional companion files agents should know about. */
  companions?:      string[];
  /**
   * For kinds with dynamic manifests, a regex that matches the manifest
   * filename when scanning the directory. Must be anchored.
   */
  manifestPattern?: RegExp;
}

export const KIND_LAYOUTS: Record<ArtifactKind, ArtifactLayout> = {
  // User-owned dirs — the same ones the Marketplace tab installs into and
  // the Library publishes from. (~/sulla/resources/* is app-managed.)
  skill: {
    manifest: 'SKILL.md',
    bundle:   'single',
  },
  function: {
    manifest:   'function.yaml',
    bundle:     'multi',
    companions: ['main.py', 'main.js', 'main.sh', 'requirements.txt', 'package.json', 'packages.txt', 'FUNCTION.md'],
  },
  workflow: {
    manifest: 'routine.yaml',
    bundle:   'single',
  },
  agent: {
    manifest:   'config.yaml',
    bundle:     'multi',
    companions: ['soul.md'],
  },
  recipe: {
    manifest:   'manifest.yaml',
    bundle:     'multi',
    companions: ['docker-compose.yml', 'installation.yaml'],
  },
  integration: {
    manifest:        'dynamic',
    bundle:          'multi',
    companions:      ['INTEGRATION.md'],
    /** e.g. `activecampaign.v3-auth.yaml`, `github.v4-auth.yaml` */
    manifestPattern: /^[a-z0-9][a-z0-9-]*\.v\d+-auth\.yaml$/,
  },
};

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(value);
}

export const KINDS_HELP = `workflow, ${ MARKETPLACE_KINDS.filter(k => k.kind !== 'routine').map(k => k.kind).join(', ') }`;

/**
 * Normalize user/agent input to an ArtifactKind. The marketplace and the
 * rest of the app call workflows "routine"; accept both spellings.
 */
export function normalizeKind(raw: unknown): ArtifactKind | null {
  const normalized = normalizeMarketplaceKind(raw);
  const k = normalized === 'routine' ? 'workflow' : normalized;

  return isArtifactKind(k) ? k : null;
}

export type MarketplaceKind = 'package' | 'routine' | 'skill' | 'function' | 'agent' | 'recipe' | 'integration';

/** Marketplace kind for an artifact kind. */
export function toMarketplaceKind(kind: ArtifactKind): MarketplaceKind | null {
  if (kind === 'workflow') return 'routine';

  return kind;
}

export function fromMarketplaceKind(kind: string): ArtifactKind {
  return kind === 'routine' ? 'workflow' : (kind as ArtifactKind);
}

export interface ArtifactSummary {
  kind:         ArtifactKind;
  slug:         string;
  name?:        string;
  version?:     string;
  description?: string;
  tags?:        string[];
  publisher?:   string;
  updated_at?:  string;
}
