import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import yaml from 'yaml';

import { postgresClient } from '@pkg/agent/database/PostgresClient';
import type { StoredFile } from '@pkg/agent/database/models/MarketplaceArtifactModel';
import type { MarketplaceTemplateDetail } from '@pkg/main/marketplace/client';

import type { PoolClient } from 'pg';

export type InstallableKind = 'agent' | 'skill' | 'routine' | 'function' | 'integration' | 'recipe';

export interface PackageContent {
  kind:     InstallableKind;
  slug:     string;
  version?: string;
  manifest: Record<string, any>;
}

export interface PackageManifest {
  apiVersion:      'sulla/v1';
  kind:            'package';
  slug:            string;
  name:            string;
  title:           string;
  line?:           string;
  topic?:          string;
  keywords?:       string[];
  icon?:           string;
  app?:            'none' | 'dashboard' | 'app';
  where?:          'both' | 'desktop';
  version:         string;
  description_md?: string;
  contents:        PackageContent[];
}

export interface InstalledArtifactRow {
  templateId:  string;
  kind:        InstallableKind;
  slug:        string;
  name:        string;
  version:     string;
  installedAt: string;
  path:        string;
}

export interface PackageInstallResult {
  ok:        boolean;
  package:   { slug: string; version: string };
  installed: { kind: InstallableKind; slug: string }[];
  skipped:   { kind: InstallableKind; slug: string; reason: string }[];
  error?:    string;
}

function jsonObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map(v => v.trim()).filter(Boolean) : [];
}

function safeSlug(value: unknown, field = 'slug'): string {
  const slug = String(value ?? '').trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) throw new Error(`${ field } must be lowercase letters, numbers, dots, underscores, or dashes`);
  return slug;
}

function stableHash(value: unknown): string {
  const sort = (input: any): any => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === 'object') return Object.fromEntries(Object.keys(input).sort().map(key => [key, sort(input[key])]));
    return input;
  };
  return `sha256:${ createHash('sha256').update(JSON.stringify(sort(value))).digest('hex') }`;
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.includes(0) || buffer.toString('utf8').includes('�');
}

/** Losslessly read an extracted bundle. The extraction layer has already rejected links and traversal. */
export function readBundleFiles(root: string): Record<string, StoredFile> {
  const files: Record<string, StoredFile> = {};
  const walk = (directory: string, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.marketplace.json' || entry.name === '.git' || entry.name === 'node_modules') continue;
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${ prefix }/${ entry.name }` : entry.name;
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) {
        const data = fs.readFileSync(absolute);
        files[relative] = looksBinary(data) ? { encoding: 'base64', content: data.toString('base64') } : data.toString('utf8');
      }
    }
  };
  walk(root);
  return files;
}

function textFile(files: Record<string, StoredFile>, ...names: string[]): string | null {
  for (const name of names) {
    const value = files[name];
    if (typeof value === 'string') return value;
  }
  return null;
}

function embeddedFiles(manifest: Record<string, any>): Record<string, StoredFile> {
  const candidates = [manifest.files, manifest.bundle?.files, manifest.spec?.files];
  for (const value of candidates) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, StoredFile>;
  }
  return {};
}

function embeddedDefinition(content: PackageContent): { manifest: Record<string, any>; files: Record<string, StoredFile> } {
  const envelope = jsonObject(content.manifest);
  const files = embeddedFiles(envelope);
  const direct = jsonObject(envelope.definition ?? envelope.manifest ?? envelope.specification);
  const manifest = Object.keys(direct).length ? direct : envelope;

  return { manifest, files };
}

function parseYamlFile(files: Record<string, StoredFile>, names: string[], label: string): Record<string, any> {
  const raw = textFile(files, ...names);
  if (!raw) throw new Error(`${ label } is missing ${ names.join(' or ') }`);
  const parsed = yaml.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${ label } manifest must be an object`);
  return parsed;
}

function integrationManifestName(files: Record<string, StoredFile>): string | null {
  if (typeof files['integration.yaml'] === 'string') return 'integration.yaml';
  return Object.keys(files).find(name => /^[^/]+\.v\d+-auth\.yaml$/.test(name) && typeof files[name] === 'string') ?? null;
}

function packageContentToArtifact(content: PackageContent): { manifest: Record<string, any>; files: Record<string, StoredFile> } {
  const embedded = embeddedDefinition(content);
  if (Object.keys(embedded.files).length === 0) return embedded;
  switch (content.kind) {
  case 'skill':
    return { manifest: embedded.manifest, files: embedded.files };
  case 'routine':
    return { manifest: textFile(embedded.files, 'routine.yaml', 'workflow.yaml') ? parseYamlFile(embedded.files, ['routine.yaml', 'workflow.yaml'], content.slug) : embedded.manifest, files: embedded.files };
  case 'function':
    return { manifest: textFile(embedded.files, 'function.yaml') ? parseYamlFile(embedded.files, ['function.yaml'], content.slug) : embedded.manifest, files: embedded.files };
  case 'integration':
    return { manifest: integrationManifestName(embedded.files) ? parseYamlFile(embedded.files, [integrationManifestName(embedded.files)!], content.slug) : embedded.manifest, files: embedded.files };
  case 'recipe':
    return { manifest: textFile(embedded.files, 'installation.yaml', 'manifest.yaml') ? parseYamlFile(embedded.files, ['installation.yaml', 'manifest.yaml'], content.slug) : embedded.manifest, files: embedded.files };
  case 'agent':
    return { manifest: textFile(embedded.files, 'agent.json') ? JSON.parse(textFile(embedded.files, 'agent.json')!) : embedded.manifest, files: embedded.files };
  }
}

export function bundleToArtifact(kind: InstallableKind, files: Record<string, StoredFile>, slug: string): { manifest: Record<string, any>; files: Record<string, StoredFile> } {
  switch (kind) {
  case 'skill': return { manifest: {}, files };
  case 'routine': return { manifest: parseYamlFile(files, ['routine.yaml', 'workflow.yaml'], slug), files };
  case 'function': return { manifest: parseYamlFile(files, ['function.yaml'], slug), files };
  case 'integration': {
    const manifestName = integrationManifestName(files);
    if (!manifestName) throw new Error(`${ slug } is missing integration.yaml or a versioned integration manifest`);
    return { manifest: parseYamlFile(files, [manifestName], slug), files };
  }
  case 'recipe': return { manifest: parseYamlFile(files, ['installation.yaml', 'manifest.yaml'], slug), files };
  case 'agent': {
    const raw = textFile(files, 'agent.json');
    if (!raw) throw new Error(`${ slug } is missing agent.json`);
    return { manifest: JSON.parse(raw), files };
  }
  }
}

async function artifactExists(client: PoolClient, kind: InstallableKind, slug: string): Promise<{ exists: boolean; userEdited: boolean }> {
  const table = kind === 'routine' ? 'workflows' : kind === 'skill' ? 'skill_definitions' : kind === 'agent' ? 'agent_definitions' : `${ kind }_definitions`;
  const edited = kind === 'skill'
    ? `(source_kind <> 'marketplace' OR (source_hash IS NOT NULL AND content_hash IS DISTINCT FROM source_hash))`
    : kind === 'agent'
      ? `(source_kind <> 'marketplace' OR user_edited)`
      : kind === 'routine'
        ? `(source_kind <> 'marketplace' OR user_edited OR system)`
        : `(source_kind <> 'marketplace' OR user_edited)`;
  const row = await client.query(`SELECT ${ edited } AS user_edited FROM ${ table } WHERE ${ kind === 'routine' ? 'id' : 'slug' } = $1`, [slug]);
  return { exists: (row.rowCount ?? 0) > 0, userEdited: row.rows[0]?.user_edited === true };
}

async function installArtifact(
  client: PoolClient,
  input: { kind: InstallableKind; slug: string; version: string; manifest: Record<string, any>; files: Record<string, StoredFile>; templateId: string; author?: string | null },
  overwrite: boolean,
): Promise<{ installed: boolean; reason?: string }> {
  const slug = safeSlug(input.slug);
  const current = await artifactExists(client, input.kind, slug);
  if (current.exists && (!overwrite || current.userEdited)) {
    return { installed: false, reason: current.userEdited ? 'existing item was created or edited by the user' : 'already installed' };
  }

  const manifest = jsonObject(input.manifest);
  const name = String(manifest.name ?? manifest.title ?? manifest.metadata?.title ?? slug);
  const description = String(manifest.description ?? manifest.metadata?.description ?? '');
  const author = input.author ?? manifest.metadata?.author ?? null;

  switch (input.kind) {
  case 'function': {
    const spec = jsonObject(manifest.spec);
    const runtime = String(spec.runtime ?? manifest.runtime ?? '');
    if (!['python', 'node', 'shell', 'agent'].includes(runtime)) throw new Error(`function ${ slug } has invalid runtime "${ runtime }"`);
    if (!String(spec.entrypoint ?? manifest.entrypoint ?? '').trim()) throw new Error(`function ${ slug } is missing spec.entrypoint`);
    await client.query(`INSERT INTO function_definitions
      (slug,name,description,manifest,runtime,files,source_kind,version,user_edited,marketplace_template_id,marketplace_author)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,'marketplace',$7,false,$8,$9)
      ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,manifest=EXCLUDED.manifest,runtime=EXCLUDED.runtime,files=EXCLUDED.files,version=EXCLUDED.version,user_edited=false,marketplace_template_id=EXCLUDED.marketplace_template_id,marketplace_author=EXCLUDED.marketplace_author,updated_at=now()`,
    [slug, name, description, JSON.stringify(manifest), runtime, JSON.stringify(input.files), input.version, input.templateId, author]);
    break;
  }
  case 'integration':
    if (!String(manifest.id ?? slug).trim()) throw new Error(`integration ${ slug } is missing id`);
    manifest.id = slug;
    await client.query(`INSERT INTO integration_definitions
      (slug,name,description,manifest,files,source_kind,version,user_edited,marketplace_template_id,marketplace_author)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,'marketplace',$6,false,$7,$8)
      ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,manifest=EXCLUDED.manifest,files=EXCLUDED.files,version=EXCLUDED.version,user_edited=false,marketplace_template_id=EXCLUDED.marketplace_template_id,marketplace_author=EXCLUDED.marketplace_author,updated_at=now()`,
    [slug, name, description, JSON.stringify(manifest), JSON.stringify(input.files), input.version, input.templateId, author]);
    break;
  case 'recipe': {
    const composeName = String(manifest.compose?.composeFile ?? manifest.composeFile ?? 'docker-compose.yml');
    const compose = textFile(input.files, composeName, 'docker-compose.yml', 'compose.yaml', 'compose.yml');
    if (!compose) throw new Error(`recipe ${ slug } is missing its compose file`);
    await client.query(`INSERT INTO recipe_definitions
      (slug,name,description,manifest,compose,files,source_kind,version,user_edited,marketplace_template_id,marketplace_author)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,'marketplace',$7,false,$8,$9)
      ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,manifest=EXCLUDED.manifest,compose=EXCLUDED.compose,files=EXCLUDED.files,version=EXCLUDED.version,user_edited=false,marketplace_template_id=EXCLUDED.marketplace_template_id,marketplace_author=EXCLUDED.marketplace_author,updated_at=now()`,
    [slug, name, description, JSON.stringify(manifest), compose, JSON.stringify(input.files), input.version, input.templateId, author]);
    break;
  }
  case 'routine':
    if (!Array.isArray(manifest.nodes) || !Array.isArray(manifest.edges)) throw new Error(`routine ${ slug } must contain nodes and edges arrays`);
    manifest.id = slug;
    await client.query(`INSERT INTO workflows
      (id,name,description,version,status,definition,enabled,source_kind,user_edited,marketplace_template_id,marketplace_author)
      VALUES ($1,$2,$3,$4,'production',$5::jsonb,true,'marketplace',false,$6,$7)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,version=EXCLUDED.version,status='production',definition=EXCLUDED.definition,enabled=true,source_kind='marketplace',user_edited=false,marketplace_template_id=EXCLUDED.marketplace_template_id,marketplace_author=EXCLUDED.marketplace_author,updated_at=now()`,
    [slug, name, description, input.version, JSON.stringify(manifest), input.templateId, author]);
    break;
  case 'skill': {
    const { hashSkillContent, parseSkillMarkdown } = await import('@pkg/agent/services/SkillDefinitionService');
    const skillText = textFile(input.files, 'SKILL.md') ?? (typeof manifest.content === 'string' ? manifest.content : null);
    if (!skillText) throw new Error(`skill ${ slug } is missing SKILL.md content`);
    const extraFiles = { ...input.files };
    delete extraFiles['SKILL.md'];
    const parsed = parseSkillMarkdown(skillText, slug, extraFiles);
    if (!parsed) throw new Error(`skill ${ slug } has an invalid SKILL.md`);
    if (parsed.slug !== slug) throw new Error(`skill manifest slug "${ parsed.slug }" does not match "${ slug }"`);
    const contentHash = hashSkillContent(parsed.content);
    await client.query(`INSERT INTO skill_definitions
      (id,slug,title,description,tags,triggers,body,frontmatter,frontmatter_text,files,version,source_kind,source_hash,content_hash,enabled,deleted_at,marketplace_template_id,marketplace_slug,marketplace_version,marketplace_author)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,'marketplace',$12,$12,true,NULL,$13,$2,$11,$14)
      ON CONFLICT (slug) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,tags=EXCLUDED.tags,triggers=EXCLUDED.triggers,body=EXCLUDED.body,frontmatter=EXCLUDED.frontmatter,frontmatter_text=EXCLUDED.frontmatter_text,files=EXCLUDED.files,version=EXCLUDED.version,source_kind='marketplace',source_hash=EXCLUDED.source_hash,content_hash=EXCLUDED.content_hash,enabled=true,deleted_at=NULL,marketplace_template_id=EXCLUDED.marketplace_template_id,marketplace_slug=EXCLUDED.marketplace_slug,marketplace_version=EXCLUDED.marketplace_version,marketplace_author=EXCLUDED.marketplace_author,updated_at=now()`,
    [`skill-${ randomUUID() }`, slug, parsed.content.title, parsed.content.description, parsed.content.tags, parsed.content.triggers, parsed.content.body, JSON.stringify(parsed.content.frontmatter), parsed.content.frontmatter_text, JSON.stringify(parsed.content.files), input.version || parsed.content.version, contentHash, input.templateId, author]);
    break;
  }
  case 'agent': {
    const metadata = jsonObject(manifest.metadata);
    const spec = jsonObject(manifest.spec);
    if (!metadata.slug || !metadata.title || typeof spec.prompt !== 'string') throw new Error(`agent ${ slug } has an invalid sulla/v3 manifest`);
    if (String(metadata.slug) !== slug) throw new Error(`agent manifest slug "${ metadata.slug }" does not match "${ slug }"`);
    const directory = jsonObject(spec.directory);
    await client.query(`INSERT INTO agent_definitions
      (id,slug,name,description,system_prompt,soul_content,allowed_tools,skill_refs,routine_refs,model_priority,version,status,enabled,config,prompt_content,goals_content,prompt_files,provider,model,source_kind,marketplace_template_id,marketplace_slug,marketplace_version,marketplace_author,when_to_call,when_not_to_call,send,returns,cost_tier,can_call,front_door,user_edited)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]'::jsonb,$10,'production',true,$11::jsonb,$5,$12,$13::jsonb,$14,$15,'marketplace',$16,$2,$10,$17,$18,$19,$20,$21,$22,$23,$24,false)
      ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,system_prompt=EXCLUDED.system_prompt,soul_content=EXCLUDED.soul_content,allowed_tools=EXCLUDED.allowed_tools,skill_refs=EXCLUDED.skill_refs,version=EXCLUDED.version,status='production',enabled=true,config=EXCLUDED.config,prompt_content=EXCLUDED.prompt_content,goals_content=EXCLUDED.goals_content,prompt_files=EXCLUDED.prompt_files,provider=EXCLUDED.provider,model=EXCLUDED.model,source_kind='marketplace',marketplace_template_id=EXCLUDED.marketplace_template_id,marketplace_slug=EXCLUDED.marketplace_slug,marketplace_version=EXCLUDED.marketplace_version,marketplace_author=EXCLUDED.marketplace_author,when_to_call=EXCLUDED.when_to_call,when_not_to_call=EXCLUDED.when_not_to_call,send=EXCLUDED.send,returns=EXCLUDED.returns,cost_tier=EXCLUDED.cost_tier,can_call=EXCLUDED.can_call,front_door=EXCLUDED.front_door,user_edited=false,updated_at=now()`,
    [`agent-${ randomUUID() }`, slug, metadata.title, metadata.description ?? '', spec.prompt, spec.soul ?? '', stringArray(spec.tools), stringArray(spec.skills), stringArray(spec.routines), input.version, JSON.stringify(spec.config ?? {}), spec.goals ?? '', JSON.stringify(spec.promptFiles ?? {}), spec.provider ?? null, spec.model ?? null, input.templateId, author, directory.whenToCall ?? '', directory.whenNotToCall ?? '', directory.send ?? '', directory.returns ?? '', directory.costTier ?? null, stringArray(directory.canCall), typeof directory.frontDoor === 'boolean' ? directory.frontDoor : null]);
    break;
  }
  }
  return { installed: true };
}

export async function installStandaloneArtifact(
  detail: MarketplaceTemplateDetail,
  artifact: { manifest: Record<string, any>; files: Record<string, StoredFile> },
  overwrite = false,
): Promise<{ installed: boolean; reason?: string }> {
  if (detail.kind === 'package') throw new Error('Packages must be installed with installPackageManifest');
  const result = await postgresClient.transaction(client => installArtifact(client, {
    kind:       detail.kind as InstallableKind,
    slug:       detail.slug,
    version:    detail.version,
    manifest:   artifact.manifest,
    files:      artifact.files,
    templateId: detail.id,
    author:     detail.author_display,
  }, overwrite));
  if (result.installed) await refreshRuntimeCatalogs([detail.kind as InstallableKind]);
  return result;
}

async function refreshRuntimeCatalogs(kinds: InstallableKind[]): Promise<void> {
  try {
    if (kinds.includes('skill')) {
      const { skillsRegistry } = await import('@pkg/agent/database/registry/SkillsRegistry');
      await skillsRegistry.invalidate();
    }
    if (kinds.includes('integration')) {
      const { refreshIntegrationCatalog } = await import('@pkg/agent/integrations/catalog');
      await refreshIntegrationCatalog();
    }
  } catch (error) {
    // The database transaction is already committed. A process that has not
    // started its registries yet must not turn a successful install into an
    // error response; startup refreshes both catalogs from Postgres.
    console.warn('Marketplace artifact installed, but live catalog refresh failed:', error);
  }
}

export function validatePackageManifest(value: unknown): PackageManifest {
  const manifest = jsonObject(value) as Partial<PackageManifest>;
  if (manifest.apiVersion !== 'sulla/v1' || manifest.kind !== 'package') throw new Error('Package manifest must be apiVersion sulla/v1 and kind package');
  safeSlug(manifest.slug, 'package slug');
  if (!manifest.name || !manifest.title || !manifest.version) throw new Error('Package manifest requires slug, name, title, and version');
  if (!Array.isArray(manifest.contents) || manifest.contents.length === 0) throw new Error('Package manifest contents must be a non-empty array');
  for (const [index, item] of manifest.contents.entries()) {
    if (!item || !['agent', 'skill', 'routine', 'function', 'integration', 'recipe'].includes(item.kind)) throw new Error(`Package item ${ index } has an invalid kind`);
    safeSlug(item.slug, `package item ${ index } slug`);
    if (!item.manifest || typeof item.manifest !== 'object' || Array.isArray(item.manifest)) throw new Error(`Package item ${ index } manifest must be an object`);
  }
  return manifest as PackageManifest;
}

/** The transaction boundary deliberately includes every item and the package receipt. */
export async function installPackageManifest(
  templateId: string,
  value: unknown,
  author?: string | null,
  database: Pick<typeof postgresClient, 'transaction'> = postgresClient,
): Promise<PackageInstallResult> {
  const manifest = validatePackageManifest(value);
  const result = await database.transaction(async(client) => {
    const duplicate = await client.query('SELECT slug FROM installed_packages WHERE slug = $1 OR template_id = $2', [manifest.slug, templateId]);
    if (duplicate.rowCount) throw new Error(`Package "${ manifest.slug }" is already installed`);
    const installed: PackageInstallResult['installed'] = [];
    const skipped: PackageInstallResult['skipped'] = [];

    for (const content of manifest.contents) {
      const artifact = packageContentToArtifact(content);
      const outcome = await installArtifact(client, {
        kind:     content.kind,
        slug:     content.slug,
        version:  content.version ?? manifest.version,
        manifest: artifact.manifest,
        files:    artifact.files,
        templateId,
        author,
      }, false);
      if (!outcome.installed) {
        skipped.push({ kind: content.kind, slug: content.slug, reason: outcome.reason ?? 'already present' });
        continue;
      }
      installed.push({ kind: content.kind, slug: content.slug });
    }

    await client.query(`INSERT INTO installed_packages (slug,template_id,version,name,title,icon,manifest)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [manifest.slug, templateId, manifest.version, manifest.name, manifest.title, manifest.icon ?? '', JSON.stringify(manifest)]);
    for (const item of installed) {
      await client.query(`INSERT INTO installed_package_items (package_slug,kind,item_slug,installed_template_id)
        VALUES ($1,$2,$3,$4)`, [manifest.slug, item.kind, item.slug, templateId]);
    }
    return { installed, skipped };
  });

  await refreshRuntimeCatalogs(result.installed.map(item => item.kind));

  return { ok: true, package: { slug: manifest.slug, version: manifest.version }, ...result };
}

export async function listInstalledPackages(): Promise<{ slug: string; version: string; name: string; title: string; icon: string; installedAt: string; items: { kind: InstallableKind; slug: string }[] }[]> {
  const rows = await postgresClient.query(`SELECT p.*, COALESCE(jsonb_agg(jsonb_build_object('kind', i.kind, 'slug', i.item_slug) ORDER BY i.kind, i.item_slug) FILTER (WHERE i.item_slug IS NOT NULL), '[]'::jsonb) AS items
    FROM installed_packages p LEFT JOIN installed_package_items i ON i.package_slug = p.slug
    GROUP BY p.slug ORDER BY p.installed_at DESC`);
  return rows.map((row: any) => ({
    slug:        row.slug,
    version:     row.version,
    name:        row.name,
    title:       row.title,
    icon:        row.icon,
    installedAt: row.installed_at instanceof Date ? row.installed_at.toISOString() : String(row.installed_at),
    items:       (row.items ?? []).map((item: any) => ({ kind: item.kind, slug: item.slug })),
  }));
}

async function removePackageItem(client: PoolClient, kind: InstallableKind, slug: string, templateId: string): Promise<boolean> {
  const statements: Record<InstallableKind, string> = {
    function:    `DELETE FROM function_definitions WHERE slug=$1 AND source_kind='marketplace' AND user_edited=false AND marketplace_template_id=$2 RETURNING slug`,
    integration: `DELETE FROM integration_definitions WHERE slug=$1 AND source_kind='marketplace' AND user_edited=false AND marketplace_template_id=$2 RETURNING slug`,
    recipe:      `DELETE FROM recipe_definitions WHERE slug=$1 AND source_kind='marketplace' AND user_edited=false AND marketplace_template_id=$2 RETURNING slug`,
    routine:     `DELETE FROM workflows WHERE id=$1 AND source_kind='marketplace' AND user_edited=false AND marketplace_template_id=$2 RETURNING id`,
    agent:       `DELETE FROM agent_definitions WHERE slug=$1 AND source_kind='marketplace' AND user_edited=false AND marketplace_template_id=$2 RETURNING slug`,
    skill:       `DELETE FROM skill_definitions WHERE slug=$1 AND source_kind='marketplace' AND marketplace_template_id=$2 AND (source_hash IS NULL OR content_hash IS NOT DISTINCT FROM source_hash) RETURNING slug`,
  };
  const result = await client.query(statements[kind], [slug, templateId]);
  return (result.rowCount ?? 0) > 0;
}

export async function uninstallPackage(slug: string): Promise<{ ok: true; removed: { kind: InstallableKind; slug: string }[] }> {
  const recipeItems = await postgresClient.query(`SELECT i.item_slug
    FROM installed_package_items i
    JOIN installed_packages p ON p.slug=i.package_slug
    JOIN recipe_definitions r ON r.slug=i.item_slug AND r.marketplace_template_id=p.template_id
    WHERE i.package_slug=$1 AND i.kind='recipe'`, [slug]);
  if (recipeItems.length > 0) {
    const { stopStoredRecipe } = await import('@pkg/main/sullaRecipeDockerEvents');
    for (const item of recipeItems) await stopStoredRecipe(String(item.item_slug));
  }

  const result = await postgresClient.transaction(async(client) => {
    const pkg = await client.query('SELECT template_id FROM installed_packages WHERE slug=$1 FOR UPDATE', [slug]);
    if (!pkg.rowCount) throw new Error(`Package "${ slug }" is not installed`);
    const templateId = String(pkg.rows[0].template_id);
    const items = await client.query('SELECT kind,item_slug FROM installed_package_items WHERE package_slug=$1 ORDER BY installed_at DESC', [slug]);
    const removed: { kind: InstallableKind; slug: string }[] = [];
    for (const item of items.rows) {
      if (await removePackageItem(client, item.kind as InstallableKind, item.item_slug, templateId)) removed.push({ kind: item.kind, slug: item.item_slug });
    }
    await client.query('DELETE FROM installed_packages WHERE slug=$1', [slug]);
    return { ok: true as const, removed };
  });
  await refreshRuntimeCatalogs(result.removed.map(item => item.kind));
  return result;
}

export async function listInstalledArtifacts(): Promise<InstalledArtifactRow[]> {
  const rows = await postgresClient.query(`
    SELECT marketplace_template_id AS template_id, 'function' AS kind, slug, name, COALESCE(version,'1.0.0') AS version, updated_at FROM function_definitions WHERE source_kind='marketplace'
    UNION ALL SELECT marketplace_template_id, 'integration', slug, name, COALESCE(version,'1.0.0'), updated_at FROM integration_definitions WHERE source_kind='marketplace'
    UNION ALL SELECT marketplace_template_id, 'recipe', slug, name, COALESCE(version,'1.0.0'), updated_at FROM recipe_definitions WHERE source_kind='marketplace'
    UNION ALL SELECT marketplace_template_id, 'routine', id, name, COALESCE(version,'1.0.0'), updated_at FROM workflows WHERE source_kind='marketplace'
    UNION ALL SELECT marketplace_template_id, 'skill', slug, title, COALESCE(marketplace_version,version,'1.0.0'), updated_at FROM skill_definitions WHERE source_kind='marketplace' AND deleted_at IS NULL
    UNION ALL SELECT marketplace_template_id, 'agent', slug, name, COALESCE(marketplace_version,version,'1.0.0'), updated_at FROM agent_definitions WHERE source_kind='marketplace' AND status <> 'archive'
  `);
  return rows.filter((row: any) => row.template_id).map((row: any) => ({
    templateId:  row.template_id,
    kind:        row.kind,
    slug:        row.slug,
    name:        row.name,
    version:     row.version,
    installedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    path:        `database:${ row.kind }_definitions/${ row.slug }`,
  }));
}
