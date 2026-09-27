/**
 * Shared types and per-kind layout knowledge for the marketplace tool family.
 *
 * Each artifact kind has a different local directory and manifest file, but
 * the marketplace API treats them uniformly via `<kind>/<slug>` addressing.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  resolveSullaAgentsDir,
  resolveSullaFunctionsDir,
  resolveSullaRecipesDir,
  resolveSullaRoutinesDir,
  resolveSullaUserIntegrationsDir,
  resolveSullaUserSkillsDir,
} from '@pkg/agent/utils/sullaPaths';

export const ARTIFACT_KINDS = ['skill', 'function', 'workflow', 'agent', 'recipe', 'integration'] as const;
export type ArtifactKind = typeof ARTIFACT_KINDS[number];

export interface ArtifactLayout {
  /** Absolute path to the directory that holds <slug>/ subdirs for this kind. */
  rootDir():       string;
  /**
   * Filename of the primary manifest inside an artifact's directory.
   * For most kinds this is a literal filename (`function.yaml`).
   * For integrations it is `dynamic` — the filename is slug-dependent
   * (`<slug>.v<N>-auth.yaml`) and must be resolved at runtime via
   * {@link resolveArtifactManifestPath}.
   */
  manifest:        string | 'dynamic';
  /** Whether the artifact is a single-file or multi-file bundle. */
  bundle:          'single' | 'multi';
  /** Optional companion files agents should know about. */
  companions?:     string[];
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
    rootDir:  () => resolveSullaUserSkillsDir(),
    manifest: 'SKILL.md',
    bundle:   'single',
  },
  function: {
    rootDir:    () => resolveSullaFunctionsDir(),
    manifest:   'function.yaml',
    bundle:     'multi',
    companions: ['main.py', 'main.js', 'main.sh', 'requirements.txt', 'package.json', 'packages.txt', 'FUNCTION.md'],
  },
  workflow: {
    rootDir:  () => resolveSullaRoutinesDir(),
    manifest: 'routine.yaml',
    bundle:   'single',
  },
  agent: {
    rootDir:    () => resolveSullaAgentsDir(),
    manifest:   'config.yaml',
    bundle:     'multi',
    companions: ['soul.md'],
  },
  recipe: {
    rootDir:    () => resolveSullaRecipesDir(),
    manifest:   'manifest.yaml',
    bundle:     'multi',
    companions: ['docker-compose.yml', 'installation.yaml'],
  },
  integration: {
    rootDir:         () => resolveSullaUserIntegrationsDir(),
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

export const KINDS_HELP = 'skill, function, routine (alias: workflow), agent, recipe, integration';

/**
 * Normalize user/agent input to an ArtifactKind. The marketplace and the
 * rest of the app call workflows "routine"; accept both spellings.
 */
export function normalizeKind(raw: unknown): ArtifactKind | null {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const k = v === 'routine' || v === 'routines' ? 'workflow' : v.replace(/s$/, '');

  return isArtifactKind(k) ? k : (isArtifactKind(v) ? v : null);
}

export type MarketplaceKind = 'routine' | 'skill' | 'function' | 'recipe' | 'integration';

/** Marketplace kind for an artifact kind, or null when the kind isn't distributed there (agents). */
export function toMarketplaceKind(kind: ArtifactKind): MarketplaceKind | null {
  if (kind === 'workflow') return 'routine';
  if (kind === 'agent') return null;

  return kind;
}

export function fromMarketplaceKind(kind: string): ArtifactKind {
  return kind === 'routine' ? 'workflow' : (kind as ArtifactKind);
}

export function artifactDir(kind: ArtifactKind, slug: string): string {
  return path.join(KIND_LAYOUTS[kind].rootDir(), slug);
}

/**
 * Resolve the absolute path to the artifact's primary manifest file on disk.
 * For kinds with static manifests this is a straight `path.join`. For kinds
 * with dynamic manifests (integration) this scans the directory for a file
 * matching `manifestPattern`.
 *
 * Returns `null` if the directory doesn't exist or no matching manifest is
 * found — caller must handle both cases.
 */
export function resolveArtifactManifestPath(kind: ArtifactKind, slug: string): string | null {
  const layout = KIND_LAYOUTS[kind];
  const dir = artifactDir(kind, slug);

  if (layout.manifest !== 'dynamic') {
    const full = path.join(dir, layout.manifest);
    return fs.existsSync(full) ? full : null;
  }

  // Dynamic — scan.
  if (!fs.existsSync(dir)) return null;
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  const pattern = layout.manifestPattern;
  if (!pattern) return null;
  const match = entries.find(name => pattern.test(name));
  return match ? path.join(dir, match) : null;
}

/**
 * @deprecated Use {@link resolveArtifactManifestPath} which actually checks
 * disk. Kept as a convenience for paths where we only need the conventional
 * location (e.g. scaffolding where the file hasn't been written yet and we
 * want a stable spot). Not safe for integrations.
 */
export function artifactManifestPath(kind: ArtifactKind, slug: string): string {
  const layout = KIND_LAYOUTS[kind];
  if (layout.manifest === 'dynamic') {
    throw new Error(`artifactManifestPath: kind "${ kind }" has a dynamic manifest; use resolveArtifactManifestPath instead.`);
  }
  return path.join(artifactDir(kind, slug), layout.manifest);
}

export interface ArtifactSummary {
  kind:        ArtifactKind;
  slug:        string;
  name?:       string;
  version?:    string;
  description?: string;
  tags?:       string[];
  publisher?:  string;
  updated_at?: string;
}
