/** Database-backed Library IPC handlers. */
import yaml from 'yaml';

import type { StoredFile } from '@pkg/agent/database/models/MarketplaceArtifactModel';
import { getIpcMainProxy } from '@pkg/main/ipcMain';
import { readDatabaseArtifact } from '@pkg/main/marketplace/databaseArtifacts';
import type { InstallableKind } from '@pkg/main/marketplace/databaseInstaller';
import { rewriteRecipeCompose } from '@pkg/main/marketplace/recipeRuntime';
import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

type KindPlural = 'routines' | 'skills' | 'functions' | 'recipes' | 'integrations';
type KindSingular = Exclude<InstallableKind, 'agent'>;

const KIND_TO_SINGULAR: Record<KindPlural, KindSingular> = {
  routines: 'routine', skills: 'skill', functions: 'function', recipes: 'recipe', integrations: 'integration',
};

function storedSize(file: StoredFile): number {
  return typeof file === 'string' ? Buffer.byteLength(file) : Buffer.byteLength(file.content, 'base64');
}

function fileListing(slug: string, files: Record<string, StoredFile>): { path: string; size: number }[] {
  return Object.entries(files).map(([name, file]) => ({ path: `${ slug }/${ name }`, size: storedSize(file) }));
}

function updatedAt(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

async function listSkills() {
  const { SkillDefinitionModel } = await import('@pkg/agent/database/models/SkillDefinitionModel');

  return (await SkillDefinitionModel.list({ includeDisabled: true })).map(skill => ({
    slug:         skill.slug,
    name:         skill.title,
    description:  skill.description,
    category:     typeof skill.frontmatter.category === 'string' ? skill.frontmatter.category : undefined,
    condition:    typeof skill.frontmatter.condition === 'string' ? skill.frontmatter.condition : undefined,
    promptLength: skill.body.trim().length,
    updatedAt:    updatedAt(skill.updated_at),
  }));
}

async function listRecipes() {
  const { RecipeDefinitionModel } = await import('@pkg/agent/database/models/MarketplaceArtifactModel');

  return (await RecipeDefinitionModel.list()).map((recipe) => {
    const runtime = rewriteRecipeCompose(recipe.slug, recipe.compose, recipe.files);
    let parsed: any = {};
    try { parsed = yaml.parse(recipe.compose) } catch { /* malformed compose is reported when it is started */ }
    const image = Object.values(parsed?.services ?? {}).find((service: any) => typeof service?.image === 'string') as { image?: string } | undefined;

    return {
      slug:        recipe.slug,
      name:        recipe.name,
      description: recipe.description,
      version:     recipe.version ?? '1.0.0',
      image:       image?.image,
      extension:   recipe.manifest.extension,
      webPorts:    runtime.webPorts,
      updatedAt:   updatedAt(recipe.updated_at),
    };
  });
}

async function listIntegrations() {
  const { IntegrationDefinitionModel } = await import('@pkg/agent/database/models/MarketplaceArtifactModel');

  return (await IntegrationDefinitionModel.list()).map(row => ({
    slug:             row.slug,
    name:             row.name,
    description:      row.description,
    version:          row.version ?? '1.0.0',
    category:         row.manifest.category ?? '',
    authType:         row.manifest.authType,
    source:           (row.source_kind === 'marketplace' ? 'user' : 'resources') as 'user' | 'resources',
    bundledFunctions: Array.isArray(row.manifest.bundled?.functions) ? row.manifest.bundled.functions.length : 0,
    bundledSkills:    Array.isArray(row.manifest.bundled?.skills) ? row.manifest.bundled.skills.length : 0,
    updatedAt:        updatedAt(row.updated_at),
  }));
}

export async function buildLocalManifest(kind: KindSingular, slug: string): Promise<Record<string, any> | null> {
  let artifact;
  try {
    artifact = await readDatabaseArtifact(kind, slug);
  } catch {
    return null;
  }
  const files = fileListing(slug, artifact.files);
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const now = new Date().toISOString();
  const manifest = {
    apiVersion:      'sulla/v3',
    kind:            `${ kind[0].toUpperCase() }${ kind.slice(1) }`,
    manifestVersion: 1,
    metadata:        {
      name:        artifact.name,
      description: artifact.description,
      version:     artifact.version,
      tags:        Array.isArray(artifact.manifest.tags) ? artifact.manifest.tags : [],
      ...(artifact.manifest.category ? { category: artifact.manifest.category } : {}),
    },
    bundle:   { bundleSchemaVersion: 1, totalSize, files },
    previews: {
      ...(typeof artifact.files['README.md'] === 'string' ? { readme: artifact.files['README.md'] } : {}),
      ...(kind === 'skill' && typeof artifact.files['SKILL.md'] === 'string' ? { coreDoc: artifact.files['SKILL.md'] } : {}),
    },
    definition: artifact.manifest,
  };

  return {
    template: {
      id:             `local:${ kind }:${ slug }`,
      kind,
      slug,
      name:           artifact.name,
      description:    artifact.description,
      tagline:        null,
      version:        artifact.version,
      category:       artifact.manifest.category ?? null,
      author_user_id: 'local',
      author_display: 'You',
      tags:           manifest.metadata.tags,
      featured:       false,
      hero_media:     null,
      bundle_size:    totalSize,
      download_count: 0,
      created_at:     now,
      updated_at:     now,
      manifest,
    },
  };
}

export function initSullaLibraryEvents(): void {
  ipcMainProxy.handle('library-list-skills', async() => listSkills());
  ipcMainProxy.handle('library-list-recipes', async() => listRecipes());
  ipcMainProxy.handle('library-list-integrations', async() => listIntegrations());

  ipcMainProxy.handle('library-uninstall-integration', async(_event, slug: string) => {
    const { postgresClient } = await import('@pkg/agent/database/PostgresClient');
    const rows = await postgresClient.query(`DELETE FROM integration_definitions
      WHERE slug=$1 AND source_kind='marketplace' AND user_edited=false RETURNING slug`, [slug]);
    if (rows.length === 0) return { uninstalled: false, error: 'Only unedited marketplace integrations can be uninstalled.' };
    const { refreshIntegrationCatalog } = await import('@pkg/agent/integrations/catalog');
    await refreshIntegrationCatalog();

    return { uninstalled: true, slug, removedFunctions: [], removedSkills: [] };
  });

  ipcMainProxy.handle('library-reveal', () => ({
    revealed: false,
    error:    'This item is stored in Postgres and has no persistent definition folder.',
  }));

  ipcMainProxy.handle('library-read-manifest', async(_event, kind: KindPlural, slug: string) => {
    const singular = KIND_TO_SINGULAR[kind];
    if (!singular) return { error: `unknown kind "${ kind }"` };
    const payload = await buildLocalManifest(singular, slug);

    return payload ? payload as { template: MarketplaceBrowseRow & { manifest: Record<string, unknown> } } : { error: `no database item at ${ kind }/${ slug }` };
  });

  console.log('[Sulla] Database Library IPC handlers initialized');
}
