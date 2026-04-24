/**
 * Shared types and per-kind layout knowledge for the marketplace tool family.
 *
 * Each artifact kind has a different local directory and manifest file, but
 * the marketplace API treats them uniformly via `<kind>/<slug>` addressing.
 */

import * as path from 'path';

import {
  resolveSullaAgentsDir,
  resolveSullaFunctionsDir,
  resolveSullaRecipesDir,
  resolveSullaRoutinesDir,
  resolveSullaSkillsDir,
} from '@pkg/agent/utils/sullaPaths';

export const ARTIFACT_KINDS = ['skill', 'function', 'workflow', 'agent', 'recipe'] as const;
export type ArtifactKind = typeof ARTIFACT_KINDS[number];

export interface ArtifactLayout {
  /** Absolute path to the directory that holds <slug>/ subdirs for this kind. */
  rootDir():    string;
  /** Filename of the manifest within an artifact's directory. */
  manifest:     string;
  /** Whether the artifact is a single-file or multi-file bundle. */
  bundle:       'single' | 'multi';
  /** Optional companion files agents should know about. */
  companions?:  string[];
}

export const KIND_LAYOUTS: Record<ArtifactKind, ArtifactLayout> = {
  skill: {
    rootDir: () => resolveSullaSkillsDir(),
    manifest: 'SKILL.md',
    bundle: 'single',
  },
  function: {
    rootDir: () => resolveSullaFunctionsDir(),
    manifest: 'function.yaml',
    bundle: 'multi',
    companions: ['main.py', 'main.js', 'main.sh', 'requirements.txt', 'package.json', 'packages.txt', 'FUNCTION.md'],
  },
  workflow: {
    rootDir: () => resolveSullaRoutinesDir(),
    manifest: 'routine.yaml',
    bundle: 'single',
  },
  agent: {
    rootDir: () => resolveSullaAgentsDir(),
    manifest: 'config.yaml',
    bundle: 'multi',
    companions: ['soul.md'],
  },
  recipe: {
    rootDir: () => resolveSullaRecipesDir(),
    manifest: 'manifest.yaml',
    bundle: 'multi',
    companions: ['docker-compose.yml', 'installation.yaml'],
  },
};

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(value);
}

export function artifactDir(kind: ArtifactKind, slug: string): string {
  return path.join(KIND_LAYOUTS[kind].rootDir(), slug);
}

export function artifactManifestPath(kind: ArtifactKind, slug: string): string {
  return path.join(artifactDir(kind, slug), KIND_LAYOUTS[kind].manifest);
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
