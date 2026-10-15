import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import yaml from 'yaml';

import { materializeStoredFiles, type StoredFile } from '@pkg/agent/database/models/MarketplaceArtifactModel';
import { renderSkillMarkdown } from '@pkg/agent/services/SkillDefinitionService';
import { rewriteRecipeCompose } from '@pkg/main/marketplace/recipeRuntime';

import type { InstallableKind, PackageContent } from './databaseInstaller';

export interface DatabaseArtifact {
  kind:        InstallableKind;
  slug:        string;
  name:        string;
  description: string;
  version:     string;
  manifest:    Record<string, any>;
  files:       Record<string, StoredFile>;
}

export async function readDatabaseArtifact(kind: InstallableKind, slug: string): Promise<DatabaseArtifact> {
  if (kind === 'agent') {
    const { agentDefinitionService } = await import('@pkg/agent/services/AgentDefinitionService');
    const row = await agentDefinitionService.findBySlug(slug);
    if (!row || row.status === 'archive') throw new Error(`Agent not found in the database: ${ slug }`);
    const manifest = agentDefinitionService.toManifest(row);
    return { kind, slug, name: row.name, description: row.description, version: row.marketplace_version ?? row.version ?? '1.0.0', manifest, files: {} };
  }

  if (kind === 'skill') {
    const { SkillDefinitionModel } = await import('@pkg/agent/database/models/SkillDefinitionModel');
    const row = await SkillDefinitionModel.findBySlug(slug);
    if (!row || row.deleted_at) throw new Error(`Skill not found in the database: ${ slug }`);
    return {
      kind,
      slug,
      name:        row.title,
      description: row.description,
      version:     row.marketplace_version ?? row.version ?? '1.0.0',
      manifest:    { ...row.frontmatter, slug: row.slug, title: row.title, description: row.description },
      files:       { 'SKILL.md': renderSkillMarkdown(row), ...row.files },
    };
  }

  if (kind === 'routine') {
    const { WorkflowModel } = await import('@pkg/agent/database/models/WorkflowModel');
    const row = await WorkflowModel.findById(slug);
    const attributes = row?.attributes;
    const manifest = attributes?.definition as Record<string, any> | undefined;
    if (!manifest) throw new Error(`Workflow not found in the database: ${ slug }`);
    return {
      kind,
      slug,
      name:        String(attributes?.name ?? slug),
      description: String(attributes?.description ?? ''),
      version:     String(attributes?.version ?? manifest.version ?? '1.0.0'),
      manifest,
      files:       { 'routine.yaml': yaml.stringify(manifest) },
    };
  }

  const { FunctionDefinitionModel, IntegrationDefinitionModel, RecipeDefinitionModel } = await import('@pkg/agent/database/models/MarketplaceArtifactModel');
  if (kind === 'recipe') {
    const row = await RecipeDefinitionModel.findBySlug(slug);
    if (!row) throw new Error(`Recipe not found in the database: ${ slug }`);
    const composeName = String(row.manifest.compose?.composeFile ?? row.manifest.composeFile ?? 'docker-compose.yml');
    const runtime = rewriteRecipeCompose(slug, row.compose, row.files);

    return {
      kind,
      slug,
      name:        row.name,
      description: row.description,
      version:     row.version ?? '1.0.0',
      manifest:    { ...row.manifest, runtime: { ...row.manifest.runtime, webPorts: runtime.webPorts } },
      files:       { ...row.files, [composeName]: row.compose },
    };
  }

  const row = kind === 'function'
    ? await FunctionDefinitionModel.findBySlug(slug)
    : await IntegrationDefinitionModel.findBySlug(slug);
  if (!row) throw new Error(`${ kind[0].toUpperCase() }${ kind.slice(1) } not found in the database: ${ slug }`);

  return {
    kind,
    slug,
    name:        row.name,
    description: row.description,
    version:     row.version ?? '1.0.0',
    manifest:    row.manifest,
    files:       row.files,
  };
}

export function packageContent(artifact: DatabaseArtifact): PackageContent {
  return {
    kind:     artifact.kind,
    slug:     artifact.slug,
    version:  artifact.version,
    manifest: { definition: artifact.manifest, files: artifact.files },
  };
}

/** Materialize a DB row only long enough for the existing manifest/zip builder. */
export function materializeDatabaseArtifact(artifact: DatabaseArtifact): { dir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sulla-${ artifact.kind }-publish-`));
  const dir = path.join(root, artifact.slug);
  fs.mkdirSync(dir, { recursive: true });
  materializeStoredFiles(dir, artifact.files);

  const ensureText = (name: string, content: string) => {
    if (!fs.existsSync(path.join(dir, name))) fs.writeFileSync(path.join(dir, name), content, 'utf8');
  };
  if (artifact.kind === 'function') ensureText('function.yaml', yaml.stringify(artifact.manifest));
  if (artifact.kind === 'integration') ensureText('integration.yaml', yaml.stringify(artifact.manifest));
  if (artifact.kind === 'recipe') {
    ensureText('installation.yaml', yaml.stringify(artifact.manifest));
    const recipe = artifact as DatabaseArtifact & { manifest: Record<string, any> };
    const composeName = String(recipe.manifest?.compose?.composeFile ?? recipe.manifest?.composeFile ?? 'docker-compose.yml');
    if (!fs.existsSync(path.join(dir, composeName))) {
      throw new Error(`Recipe ${ artifact.slug } has no stored compose file`);
    }
  }
  if (artifact.kind === 'agent') {
    ensureText('agent.json', `${ JSON.stringify(artifact.manifest, null, 2) }\n`);
    ensureText('README.md', `# ${ artifact.name }\n\n${ artifact.description }\n`);
  }

  return { dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
