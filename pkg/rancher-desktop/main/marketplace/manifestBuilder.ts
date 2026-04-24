/**
 * Builds sulla/v3 marketplace manifests from a bundle on disk.
 *
 * The bundle directory is the authoritative input. For every kind, we:
 *  1. Walk the bundle, compute sha256 + size → `bundle.files[]`
 *  2. Read kind-specific "core doc" + README + CHANGELOG → `previews`
 *  3. Derive the kind-specific `*Summary` block from the core doc's
 *     frontmatter / structure
 *  4. Stamp provenance (`exportedAt`, `exportedBy.host/sullaVersion`)
 *
 * The builder is kind-aware but never network-aware — output is a pure
 * JSON object ready to be JSON.stringify'd and POSTed.
 *
 * Routine support is complete. Skill / function / recipe builders are
 * stubbed — they return a valid-but-minimal manifest, enough for the
 * marketplace worker to accept the POST. Filling in the per-kind
 * richer derivations is follow-up work tracked in the manifestBuilder
 * TODOs below.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import yaml from 'yaml';

import Logging from '@pkg/utils/logging';

import type { MarketplaceKind } from './client';

const console = Logging.background;

const MANIFEST_API_VERSION = 'sulla/v3';
const MANIFEST_VERSION = 1;
const BUNDLE_SCHEMA_VERSION = 1;

// ─── File walk + checksums ──────────────────────────────────────────

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }

  return out;
}

function sha256Hex(filePath: string): string {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));

  return h.digest('hex');
}

interface BundleFile {
  path:   string;
  size:   number;
  sha256: string;
}

function describeBundleFiles(bundleRoot: string, slugPrefix: string): { files: BundleFile[]; totalSize: number } {
  const files: BundleFile[] = [];
  let totalSize = 0;

  for (const abs of listFilesRecursive(bundleRoot)) {
    const rel = path.relative(bundleRoot, abs).split(path.sep).join('/');
    // `.routine-meta.yaml` / `.recipe-meta.yaml` and similar exporter-managed
    // files are intentionally excluded from checksums — their own checksum
    // would be self-referential.
    if (rel.startsWith('.') && rel.endsWith('-meta.yaml')) continue;

    const size = fs.statSync(abs).size;
    files.push({
      path:   `${ slugPrefix }/${ rel }`,
      size,
      sha256: sha256Hex(abs),
    });
    totalSize += size;
  }

  return { files, totalSize };
}

// ─── Source / origin metadata ───────────────────────────────────────
//
// Optional sections the envelope may carry when an artifact was IMPORTED
// from an upstream catalog (e.g. clawhub) rather than authored natively
// in our marketplace. Native exports leave these undefined.
//
// Applies to every kind (routine | skill | function | recipe).
//
// The marketplace worker mirrors these into the matching `source_*`
// columns on `marketplace_templates` (migration 036) so they're
// queryable, sortable, and don't disappear into a JSON blob.

export interface ManifestSourceAuthor {
  handle?: string | null;
  name?:   string | null;
  avatar?: string | null;
}

export interface ManifestSource {
  origin:     string;                 // e.g. 'clawhub'
  slug?:      string | null;          // slug at origin
  url?:       string | null;          // canonical URL on origin
  createdAt?: string | null;          // ISO 8601
  updatedAt?: string | null;          // ISO 8601
  author?:    ManifestSourceAuthor | null;
}

export interface ManifestSourceStats {
  installsAllTime?: number | null;
  installsCurrent?: number | null;
  downloads?:       number | null;
  stars?:           number | null;
  comments?:        number | null;
  versions?:        number | null;
}

// ─── Common envelope ────────────────────────────────────────────────

function baseEnvelope(kind: MarketplaceKind, metadata: Record<string, unknown>) {
  const kindCapitalized = kind.charAt(0).toUpperCase() + kind.slice(1);

  return {
    apiVersion:      MANIFEST_API_VERSION,
    kind:            kindCapitalized,
    manifestVersion: MANIFEST_VERSION,
    metadata,
    exportedAt:      new Date().toISOString(),
    exportedBy:      {
      host:         os.hostname(),
      sullaVersion: process.env.npm_package_version ?? null,
    },
  };
}

function readOptionalFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ─── Per-kind builders ──────────────────────────────────────────────

interface BuildOptions {
  /** The slug the bundle lives under in the zip. */
  slug:       string;
  /** Absolute path to the bundle directory on disk. */
  bundleRoot: string;
  /** Optional overrides the user provided in the publish modal. */
  overrides?: {
    name?:        string;
    description?: string;
    version?:     string;
    tags?:        string[];
  };
}

/**
 * Read an AGENT.md file and return its parsed frontmatter object or null.
 * Matches the parser in sullaRoutineTemplateEvents.ts.
 */
function readAgentFrontmatter(bundleRoot: string): Record<string, any> | null {
  const agentPath = path.join(bundleRoot, 'AGENT.md');
  const raw = readOptionalFile(agentPath);
  if (!raw) return null;
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return {};
  try {
    return yaml.parse(match[1]) as Record<string, any>;
  } catch {
    return null;
  }
}

/**
 * Build a routine manifest. Reads routine.yaml (required) + AGENT.md +
 * README.md + CHANGELOG.md from the bundle root. Derives `routineSummary`
 * from the DAG + frontmatter.
 */
function buildRoutineManifest(opts: BuildOptions): Record<string, unknown> {
  const { slug, bundleRoot, overrides } = opts;

  const routineYamlPath = path.join(bundleRoot, 'routine.yaml');
  const routineYamlRaw = readOptionalFile(routineYamlPath);
  if (!routineYamlRaw) {
    throw new Error(`routine.yaml not found at ${ routineYamlPath }`);
  }

  let routineDoc: any;
  try {
    routineDoc = yaml.parse(routineYamlRaw);
  } catch (err) {
    throw new Error(`routine.yaml is not valid YAML: ${ err instanceof Error ? err.message : String(err) }`);
  }

  const nodes = Array.isArray(routineDoc?.nodes) ? routineDoc.nodes : [];
  const edges = Array.isArray(routineDoc?.edges) ? routineDoc.edges : [];

  const triggerTypes = Array.from(new Set(
    nodes
      .filter((n: any) => n?.data?.category === 'trigger' && typeof n?.data?.subtype === 'string')
      .map((n: any) => String(n.data.subtype)),
  ));

  const agent = readAgentFrontmatter(bundleRoot) ?? {};

  const readmeRaw = readOptionalFile(path.join(bundleRoot, 'README.md'));
  const changelogRaw = readOptionalFile(path.join(bundleRoot, 'CHANGELOG.md'));
  const agentRaw = readOptionalFile(path.join(bundleRoot, 'AGENT.md'));

  const bundle = describeBundleFiles(bundleRoot, slug);

  const metadata: Record<string, unknown> = {
    name:        overrides?.name ?? agent.name ?? String(routineDoc?.name ?? slug),
    description: overrides?.description ?? String(routineDoc?.description ?? agent.summary ?? ''),
    version:     overrides?.version ?? String(routineDoc?.version ?? '1.0.0'),
    tags:        overrides?.tags ?? [],
  };

  if (agent.tagline) metadata.tagline = String(agent.tagline);
  if (agent.category) metadata.category = String(agent.category);
  if (agent.license) metadata.license = String(agent.license);
  if (agent.media) metadata.media = agent.media;
  if (agent.author) metadata.author = agent.author;
  if (agent.stats) metadata.stats = agent.stats;
  if (changelogRaw) metadata.changelog = changelogRaw;

  const previews: Record<string, string> = {
    coreDoc: routineYamlRaw,
  };
  if (readmeRaw) previews.readme = readmeRaw;
  if (agentRaw) (previews as any).agent = agentRaw;

  const routineSummary: Record<string, unknown> = {
    nodeCount:             nodes.length,
    edgeCount:             edges.length,
    triggerTypes,
    // Full DAG inlined so marketplace consumers (the public website, the
    // detail page in Sulla Desktop) can render a mock canvas without
    // parsing the preview YAML. Node/edge shape matches VueFlow's
    // serialized form — id/type/position/data for nodes,
    // id/source/target/type/handles/label for edges.
    nodes,
    edges,
  };
  if (routineDoc?.viewport && typeof routineDoc.viewport === 'object') {
    routineSummary.viewport = routineDoc.viewport;
  }
  if (Array.isArray(agent.required_integrations) && agent.required_integrations.length > 0) {
    routineSummary.requiredIntegrations = agent.required_integrations.map(String);
  }
  if (Array.isArray(agent.required_functions) && agent.required_functions.length > 0) {
    routineSummary.requiredFunctions = agent.required_functions.map(String);
  }
  if (Array.isArray(agent.required_vault_accounts) && agent.required_vault_accounts.length > 0) {
    routineSummary.requiredVaultAccounts = agent.required_vault_accounts.map(String);
  }
  if (agent.entry_node) routineSummary.entryNode = String(agent.entry_node);
  if (Array.isArray(agent.stages) && agent.stages.length > 0) routineSummary.stages = agent.stages;

  return {
    ...baseEnvelope('routine', metadata),
    bundle: {
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      totalSize:           bundle.totalSize,
      files:               bundle.files,
    },
    previews,
    routineSummary,
  };
}

/**
 * Skill manifest builder. Reads SKILL.md (required) + README.md.
 *
 * TODO: once skill local import/export ships, this should derive
 * skillSummary fields from the SKILL.md frontmatter the way the
 * routine builder derives from AGENT.md.
 */
function buildSkillManifest(opts: BuildOptions): Record<string, unknown> {
  const { slug, bundleRoot, overrides } = opts;

  const skillMdPath = path.join(bundleRoot, 'SKILL.md');
  const skillMdRaw = readOptionalFile(skillMdPath);
  if (!skillMdRaw) {
    throw new Error(`SKILL.md not found at ${ skillMdPath }`);
  }

  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(skillMdRaw);
  const frontmatter: any = match ? (yaml.parse(match[1]) ?? {}) : {};
  const body = match ? match[2] : skillMdRaw;

  const readmeRaw = readOptionalFile(path.join(bundleRoot, 'README.md'));
  const changelogRaw = readOptionalFile(path.join(bundleRoot, 'CHANGELOG.md'));
  const bundle = describeBundleFiles(bundleRoot, slug);

  const metadata: Record<string, unknown> = {
    name:        overrides?.name ?? frontmatter.name ?? slug,
    description: overrides?.description ?? frontmatter.summary ?? '',
    version:     overrides?.version ?? String(frontmatter.version ?? '1.0.0'),
    tags:        overrides?.tags ?? (Array.isArray(frontmatter.tags) ? frontmatter.tags : []),
  };
  if (frontmatter.tagline) metadata.tagline = String(frontmatter.tagline);
  if (frontmatter.license) metadata.license = String(frontmatter.license);
  if (frontmatter.author) metadata.author = frontmatter.author;
  if (changelogRaw) metadata.changelog = changelogRaw;

  const previews: Record<string, string> = { coreDoc: skillMdRaw };
  if (readmeRaw) previews.readme = readmeRaw;

  const skillSummary: Record<string, unknown> = {
    skillKey:     String(frontmatter.skillKey ?? slug),
    promptLength: body.length,
  };
  if (frontmatter.category) skillSummary.category = String(frontmatter.category);
  if (frontmatter.condition) skillSummary.condition = String(frontmatter.condition);
  if (Array.isArray(frontmatter.required_integrations)) {
    skillSummary.requiredIntegrations = frontmatter.required_integrations.map(String);
  }

  return {
    ...baseEnvelope('skill', metadata),
    bundle: {
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      totalSize:           bundle.totalSize,
      files:               bundle.files,
    },
    previews,
    skillSummary,
  };
}

/**
 * Function manifest builder. Reads function.yaml (required) + README.md.
 *
 * TODO: pull richer inputs/outputs/runtime from function.yaml's spec.
 */
function buildFunctionManifest(opts: BuildOptions): Record<string, unknown> {
  const { slug, bundleRoot, overrides } = opts;

  const functionYamlPath = path.join(bundleRoot, 'function.yaml');
  const functionYamlRaw = readOptionalFile(functionYamlPath);
  if (!functionYamlRaw) {
    throw new Error(`function.yaml not found at ${ functionYamlPath }`);
  }

  let functionDoc: any;
  try {
    functionDoc = yaml.parse(functionYamlRaw);
  } catch (err) {
    throw new Error(`function.yaml is not valid YAML: ${ err instanceof Error ? err.message : String(err) }`);
  }

  const readmeRaw = readOptionalFile(path.join(bundleRoot, 'README.md'));
  const changelogRaw = readOptionalFile(path.join(bundleRoot, 'CHANGELOG.md'));
  const bundle = describeBundleFiles(bundleRoot, slug);

  const metadata: Record<string, unknown> = {
    name:        overrides?.name ?? String(functionDoc?.metadata?.name ?? functionDoc?.name ?? slug),
    description: overrides?.description ?? String(functionDoc?.metadata?.description ?? functionDoc?.description ?? ''),
    version:     overrides?.version ?? String(functionDoc?.metadata?.version ?? functionDoc?.version ?? '1.0.0'),
    tags:        overrides?.tags ?? [],
  };
  if (changelogRaw) metadata.changelog = changelogRaw;

  const previews: Record<string, string> = { coreDoc: functionYamlRaw };
  if (readmeRaw) previews.readme = readmeRaw;

  const spec = functionDoc?.spec ?? functionDoc ?? {};
  const inputs = Array.isArray(spec.inputs) ? spec.inputs : [];
  const outputs = Array.isArray(spec.outputs) ? spec.outputs : [];

  const functionSummary: Record<string, unknown> = {
    functionName: String(functionDoc?.metadata?.name ?? functionDoc?.name ?? slug),
    runtime:      String(spec.runtime ?? 'python'),
  };
  if (inputs.length > 0) functionSummary.inputs = inputs;
  if (outputs.length > 0) functionSummary.outputs = outputs;
  if (spec.entrypoint) functionSummary.entrypoint = String(spec.entrypoint);

  return {
    ...baseEnvelope('function', metadata),
    bundle: {
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      totalSize:           bundle.totalSize,
      files:               bundle.files,
    },
    previews,
    functionSummary,
  };
}

/**
 * Recipe manifest builder. Reads installation.yaml (required) +
 * docker-compose.yml (required) + optional manifest.yaml + README.md.
 * Derives image + ports from the Compose file.
 *
 * Note on naming: the existing extension system has ONE primary YAML
 * (`installation.yaml`) that carries id/name/description + Compose
 * runtime hooks. Older sulla-recipes authors sometimes ship a separate
 * `manifest.yaml` as a catalog entry too; we read both if present, but
 * `installation.yaml` is the source of truth.
 */
function buildRecipeManifest(opts: BuildOptions): Record<string, unknown> {
  const { slug, bundleRoot, overrides } = opts;

  const installationPath = path.join(bundleRoot, 'installation.yaml');
  const installationRaw = readOptionalFile(installationPath);
  if (!installationRaw) {
    throw new Error(`installation.yaml not found at ${ installationPath }`);
  }

  let installationDoc: any;
  try {
    installationDoc = yaml.parse(installationRaw);
  } catch (err) {
    throw new Error(`installation.yaml is not valid YAML: ${ err instanceof Error ? err.message : String(err) }`);
  }

  const composePath = path.join(bundleRoot, installationDoc?.compose?.composeFile ?? 'docker-compose.yml');
  const composeRaw = readOptionalFile(composePath);
  if (!composeRaw) {
    throw new Error(`docker-compose file not found at ${ composePath }`);
  }

  let composeDoc: any = {};
  try {
    composeDoc = yaml.parse(composeRaw) ?? {};
  } catch {
    composeDoc = {};
  }

  // Optional catalog manifest (some sulla-recipes authors ship this)
  const catalogRaw = readOptionalFile(path.join(bundleRoot, 'manifest.yaml'));
  const readmeRaw = readOptionalFile(path.join(bundleRoot, 'README.md'));
  const changelogRaw = readOptionalFile(path.join(bundleRoot, 'CHANGELOG.md'));
  const bundle = describeBundleFiles(bundleRoot, slug);

  // Derive image + ports from first compose service
  const services = (composeDoc?.services && typeof composeDoc.services === 'object')
    ? composeDoc.services as Record<string, any>
    : {};
  const firstService = Object.values(services)[0];
  const image: string | undefined = firstService?.image ? String(firstService.image) : undefined;

  const ports: number[] = [];
  for (const svc of Object.values(services)) {
    const portList = Array.isArray((svc)?.ports) ? (svc).ports : [];
    for (const p of portList) {
      const str = typeof p === 'string' ? p : typeof p === 'object' ? `${ p?.published ?? '' }` : String(p);
      const hostPort = parseInt(String(str).split(':')[0], 10);
      if (!isNaN(hostPort)) ports.push(hostPort);
    }
  }

  const configKeys: string[] = [];
  for (const svc of Object.values(services)) {
    const env = (svc)?.environment;
    if (Array.isArray(env)) {
      for (const e of env) configKeys.push(String(e).split('=')[0]);
    } else if (env && typeof env === 'object') {
      configKeys.push(...Object.keys(env));
    }
  }

  const metadata: Record<string, unknown> = {
    name:        overrides?.name ?? String(installationDoc?.name ?? slug),
    description: overrides?.description ?? String(installationDoc?.description ?? ''),
    version:     overrides?.version ?? String(installationDoc?.version ?? '1.0.0'),
    tags:        overrides?.tags ?? [],
  };
  if (changelogRaw) metadata.changelog = changelogRaw;

  const previews: Record<string, string> = {
    // installation.yaml is the runtime manifest; reviewers want to see it
    // in full on the detail page.
    coreDoc: installationRaw,
  };
  if (readmeRaw) previews.readme = readmeRaw;
  if (catalogRaw) (previews as any).catalogManifest = catalogRaw;

  const recipeSummary: Record<string, unknown> = {
    extension:        String(installationDoc?.id ?? slug),
    extensionVersion: String(installationDoc?.version ?? '1.0.0'),
  };
  if (image) recipeSummary.image = image;
  if (ports.length > 0) recipeSummary.ports = Array.from(new Set(ports));
  if (configKeys.length > 0) recipeSummary.configKeys = Array.from(new Set(configKeys));

  return {
    ...baseEnvelope('recipe', metadata),
    bundle: {
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      totalSize:           bundle.totalSize,
      files:               bundle.files,
    },
    previews,
    recipeSummary,
  };
}

/**
 * Integration manifest builder. Reads integration.yaml (required) + README.md.
 *
 * The on-disk `integration.yaml` IS the runtime manifest (sulla/v1). Most of
 * the integrationSummary fields are derivable from it — authType, OAuth
 * provider, property count, and any bundled companion functions/skills
 * (fanned out to `~/sulla/functions/<slug>-<name>/` + `~/sulla/skills/<slug>-<name>/`
 * on install, per the bundled.{functions,skills} lists).
 */
function buildIntegrationManifest(opts: BuildOptions): Record<string, unknown> {
  const { slug, bundleRoot, overrides } = opts;

  const integrationYamlPath = path.join(bundleRoot, 'integration.yaml');
  const integrationYamlRaw = readOptionalFile(integrationYamlPath);
  if (!integrationYamlRaw) {
    throw new Error(`integration.yaml not found at ${ integrationYamlPath }`);
  }

  let integrationDoc: any;
  try {
    integrationDoc = yaml.parse(integrationYamlRaw);
  } catch (err) {
    throw new Error(`integration.yaml is not valid YAML: ${ err instanceof Error ? err.message : String(err) }`);
  }

  const readmeRaw = readOptionalFile(path.join(bundleRoot, 'README.md'));
  const changelogRaw = readOptionalFile(path.join(bundleRoot, 'CHANGELOG.md'));
  const bundle = describeBundleFiles(bundleRoot, slug);

  const bundled = (integrationDoc?.bundled && typeof integrationDoc.bundled === 'object')
    ? integrationDoc.bundled as { functions?: unknown; skills?: unknown }
    : null;
  const bundledFunctions = Array.isArray(bundled?.functions) ? bundled.functions.map(String) : [];
  const bundledSkills = Array.isArray(bundled?.skills) ? bundled.skills.map(String) : [];
  const properties = Array.isArray(integrationDoc?.properties) ? integrationDoc.properties : [];

  const metadata: Record<string, unknown> = {
    name:        overrides?.name ?? String(integrationDoc?.name ?? slug),
    description: overrides?.description ?? String(integrationDoc?.description ?? ''),
    version:     overrides?.version ?? String(integrationDoc?.version ?? '1.0.0'),
    tags:        overrides?.tags ?? [],
  };
  if (integrationDoc?.category) metadata.category = String(integrationDoc.category);
  if (integrationDoc?.developer) metadata.author = { displayName: String(integrationDoc.developer) };
  if (changelogRaw) metadata.changelog = changelogRaw;

  const previews: Record<string, string> = { coreDoc: integrationYamlRaw };
  if (readmeRaw) previews.readme = readmeRaw;

  const integrationSummary: Record<string, unknown> = {
    authType:      String(integrationDoc?.authType ?? 'credentials'),
    propertyCount: properties.length,
    builtin:       integrationDoc?.builtin === true,
  };
  if (integrationDoc?.oauthProviderId) integrationSummary.oauthProviderId = String(integrationDoc.oauthProviderId);
  if (integrationDoc?.sullaManagedOAuth === true) integrationSummary.sullaManagedOAuth = true;
  if (bundledFunctions.length > 0) integrationSummary.bundledFunctions = bundledFunctions;
  if (bundledSkills.length > 0) integrationSummary.bundledSkills = bundledSkills;
  if (integrationDoc?.icon) integrationSummary.icon = String(integrationDoc.icon);

  return {
    ...baseEnvelope('integration', metadata),
    bundle: {
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      totalSize:           bundle.totalSize,
      files:               bundle.files,
    },
    previews,
    integrationSummary,
  };
}

// ─── Public dispatch ────────────────────────────────────────────────

export function buildManifest(kind: MarketplaceKind, opts: BuildOptions): Record<string, unknown> {
  try {
    switch (kind) {
    case 'routine': return buildRoutineManifest(opts);
    case 'skill': return buildSkillManifest(opts);
    case 'function': return buildFunctionManifest(opts);
    case 'recipe': return buildRecipeManifest(opts);
    case 'integration': return buildIntegrationManifest(opts);
    default: throw new Error(`unsupported kind: ${ String(kind) }`);
    }
  } catch (err) {
    console.error(`[manifestBuilder] kind=${ kind } slug=${ opts.slug } failed:`, err);
    throw err;
  }
}
