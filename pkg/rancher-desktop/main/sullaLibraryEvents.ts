/**
 * Library IPC handlers.
 *
 * Scanners for the four library kinds plus a reverse-engineered
 * manifest reader so the same MarketplaceDetail drawer can render
 * local items and remote marketplace items with zero forking.
 *
 *   library-list-skills     → scan ~/sulla/skills/<slug>/SKILL.md
 *   library-list-recipes    → scan ~/sulla/recipes/<slug>/manifest.yaml
 *   library-reveal          → open the item's folder in the OS file manager
 *   library-read-manifest   → build a sulla/v3-shaped { template, manifest }
 *                             payload from the on-disk slug directory
 *
 * Routines and functions keep their own canonical scanners
 * (`routines-template-list` and `functions-list`); read-manifest
 * consumes them for consistency so the UI only has one shape.
 *
 * Defensive: malformed files don't break the whole listing — a bad
 * entry is skipped with a log line and the rest of the library still
 * renders.
 */

import * as fs from 'fs';
import * as path from 'path';

import { shell } from 'electron';
import yaml from 'yaml';

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

import type { IntegrationManifest } from '@pkg/agent/integrations/schema';
import type { ManifestSource } from '@pkg/agent/integrations/loader';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

function getSkillsDir(): string {
  const { resolveSullaUserSkillsDir } = require('@pkg/agent/utils/sullaPaths');

  return resolveSullaUserSkillsDir();
}

function getRecipesDir(): string {
  const { resolveSullaRecipesDir } = require('@pkg/agent/utils/sullaPaths');

  return resolveSullaRecipesDir();
}

/**
 * Parse the YAML frontmatter at the top of a markdown file. Returns null
 * if there's no frontmatter block or it's unparseable.
 *
 * Frontmatter convention: `---\n<yaml>\n---\n<body>`.
 */
function parseFrontmatter(text: string): Record<string, unknown> | null {
  if (!text.startsWith('---')) return null;
  const closeIdx = text.indexOf('\n---', 3);
  if (closeIdx < 0) return null;

  const yamlBlock = text.slice(3, closeIdx).replace(/^\n/, '');
  try {
    const doc = yaml.parse(yamlBlock);

    return doc && typeof doc === 'object' ? doc as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function pickString(obj: Record<string, unknown> | null, key: string): string | undefined {
  if (!obj) return undefined;
  const v = obj[key];

  return typeof v === 'string' ? v : undefined;
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[Sulla] library scan: cannot read ${ dir }:`, err);

    return [];
  }
}

function readTextSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

function mtimeIso(p: string): string {
  try {
    return fs.statSync(p).mtime.toISOString();
  } catch {
    return '';
  }
}

// ─── Skills ──────────────────────────────────────────────────────

interface SkillRow {
  slug:         string;
  name:         string;
  description:  string;
  category?:    string;
  condition?:   string;
  promptLength: number;
  updatedAt:    string;
}

function scanSkills(): SkillRow[] {
  const dir = getSkillsDir();
  const entries = safeReaddir(dir);
  const rows: SkillRow[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const skillMd = path.join(dir, slug, 'SKILL.md');
    const text = readTextSafe(skillMd);
    if (text == null) continue;

    const fm = parseFrontmatter(text);
    // Compute prompt length as "markdown body after frontmatter" — gives
    // the user a rough sense of skill size on the card.
    const bodyStart = text.startsWith('---')
      ? text.indexOf('\n---', 3) + 4
      : 0;
    const body = text.slice(bodyStart).trim();

    rows.push({
      slug,
      name:         pickString(fm, 'name') ?? slug,
      description:  pickString(fm, 'description') ?? '',
      category:     pickString(fm, 'category'),
      condition:    pickString(fm, 'condition'),
      promptLength: body.length,
      updatedAt:    mtimeIso(skillMd),
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));

  return rows;
}

// ─── Recipes ─────────────────────────────────────────────────────

interface RecipeRow {
  slug:        string;
  name:        string;
  description: string;
  version:     string;
  image?:      string;
  extension?:  string;
  updatedAt:   string;
}

function readComposeImage(recipeDir: string): string | undefined {
  const composePath = path.join(recipeDir, 'docker-compose.yml');
  const text = readTextSafe(composePath);
  if (!text) return undefined;

  try {
    const doc = yaml.parse(text) as { services?: Record<string, { image?: unknown } | undefined> } | null;
    const services = doc?.services;
    if (!services || typeof services !== 'object') return undefined;
    for (const service of Object.values(services)) {
      if (service && typeof service.image === 'string') return service.image;
    }
  } catch {
    // fallthrough — compose is either missing or malformed; leave image undefined
  }

  return undefined;
}

function scanRecipes(): RecipeRow[] {
  const dir = getRecipesDir();
  const entries = safeReaddir(dir);
  const rows: RecipeRow[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const recipeDir = path.join(dir, slug);
    const manifestPath = path.join(recipeDir, 'manifest.yaml');
    const manifestText = readTextSafe(manifestPath);
    if (manifestText == null) continue;

    let manifest: Record<string, unknown> | null = null;
    try {
      const parsed = yaml.parse(manifestText);
      manifest = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch (err) {
      console.warn(`[Sulla] recipe ${ slug } has unparseable manifest.yaml:`, err);
      continue;
    }

    rows.push({
      slug,
      name:        pickString(manifest, 'name') ?? slug,
      description: pickString(manifest, 'description') ?? '',
      version:     pickString(manifest, 'version') ?? '0.0.0',
      image:       readComposeImage(recipeDir),
      extension:   pickString(manifest, 'extension'),
      updatedAt:   mtimeIso(manifestPath),
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));

  return rows;
}

// ─── Integrations ────────────────────────────────────────────────

interface IntegrationRow {
  slug:              string;
  name:              string;
  description:       string;
  version:           string;
  category:          string;
  authType?:         string;
  /** 'resources' for builtin defaults, 'user' for marketplace installs. */
  source:            'resources' | 'user';
  /** Count of bundled functions/skills, for at-a-glance strip meta. */
  bundledFunctions?: number;
  bundledSkills?:    number;
  updatedAt:         string;
}

function scanIntegrations(): IntegrationRow[] {
  // The loader scans both ~/sulla/resources/integrations/ (builtin) and
  // ~/sulla/integrations/ (marketplace installs), validates each manifest,
  // and merges with user-dir-wins. We reuse it verbatim so the Library view
  // is always a faithful mirror of what the catalog actually loads.
  const { loadCatalog } = require('@pkg/agent/integrations/loader');
  const { manifests, sources } = loadCatalog() as {
    manifests: Record<string, IntegrationManifest>;
    sources:   Record<string, ManifestSource>;
  };

  const {
    resolveSullaIntegrationsDir,
    resolveSullaUserIntegrationsDir,
  } = require('@pkg/agent/utils/sullaPaths');

  const rootFor = (source: 'resources' | 'user'): string =>
    (source === 'resources'
      ? resolveSullaIntegrationsDir()
      : resolveSullaUserIntegrationsDir());

  const rows: IntegrationRow[] = [];

  for (const [slug, manifest] of Object.entries(manifests)) {
    const source = (sources[slug] ?? 'resources') as 'resources' | 'user';
    const manifestPath = path.join(rootFor(source), slug, 'integration.yaml');

    rows.push({
      slug,
      name:             manifest.name,
      description:      manifest.description,
      version:          manifest.version,
      category:         manifest.category,
      authType:         manifest.authType,
      source,
      bundledFunctions: manifest.bundled?.functions?.length,
      bundledSkills:    manifest.bundled?.skills?.length,
      updatedAt:        mtimeIso(manifestPath),
    });
  }

  rows.sort((a, b) => {
    // Group builtins first, then alphabetical within group.
    if (a.source !== b.source) return a.source === 'resources' ? -1 : 1;

    return a.name.localeCompare(b.name);
  });

  return rows;
}

// ─── Manifest builder ───────────────────────────────────────────
// Re-constructs a sulla/v3-shaped manifest from what's on disk so the
// detail drawer can render a local library item with the same component
// used for marketplace entries. We don't try to recover what wasn't
// there in the first place — missing sections render as empty in the UI.

type KindPlural = 'routines' | 'skills' | 'functions' | 'recipes' | 'integrations';
type KindSingular = 'routine' | 'skill' | 'function' | 'recipe' | 'integration';

const KIND_TO_PLURAL: Record<KindSingular, KindPlural> = {
  routine: 'routines', skill: 'skills', function: 'functions', recipe: 'recipes', integration: 'integrations',
};
const KIND_TO_SINGULAR: Record<KindPlural, KindSingular> = {
  routines: 'routine', skills: 'skill', functions: 'function', recipes: 'recipe', integrations: 'integration',
};

function kindBaseDir(pluralKind: KindPlural): string {
  const {
    resolveSullaRoutinesDir,
    resolveSullaFunctionsDir,
    resolveSullaUserSkillsDir,
    resolveSullaRecipesDir,
    resolveSullaUserIntegrationsDir,
  } = require('@pkg/agent/utils/sullaPaths');

  switch (pluralKind) {
  case 'routines': return resolveSullaRoutinesDir();
  case 'skills': return resolveSullaUserSkillsDir();
  case 'functions': return resolveSullaFunctionsDir();
  case 'recipes': return resolveSullaRecipesDir();
  case 'integrations': return resolveSullaUserIntegrationsDir();
  }
}

/**
 * Resolve an item's on-disk directory, searching every location where
 * items of that kind can live. Integrations are the only kind with two
 * possible homes (resources/builtin vs user/marketplace); the others
 * have a single canonical base dir so `kindBaseDir` suffices there.
 */
function findItemDir(kind: KindSingular, slug: string): string | null {
  const paths = require('@pkg/agent/utils/sullaPaths');

  const candidates: string[] = (() => {
    switch (kind) {
    case 'routine': return [paths.resolveSullaRoutinesDir()];
    case 'skill': return [paths.resolveSullaUserSkillsDir()];
    case 'function': return [paths.resolveSullaFunctionsDir()];
    case 'recipe': return [paths.resolveSullaRecipesDir()];
    case 'integration': return [paths.resolveSullaUserIntegrationsDir(), paths.resolveSullaIntegrationsDir()];
    }
  })();

  for (const base of candidates) {
    const candidate = path.join(base, slug);

    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  return null;
}

interface BundleFileEntry {
  path: string;
  size: number;
}

/**
 * Recursively walk `root`, returning every file's path relative to
 * `root`'s parent. The returned paths always start with the slug
 * directory name, matching the sulla/v3 bundle.files convention
 * (`<slug>/<relpath>`).
 */
function walkBundleFiles(root: string, slug: string): BundleFileEntry[] {
  const results: BundleFileEntry[] = [];

  const walk = (abs: string, relPrefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.routine-meta.yaml' && entry.name !== '.skill-meta.yaml' && entry.name !== '.function-meta.yaml' && entry.name !== '.recipe-meta.yaml') {
        continue;
      }
      const childAbs = path.join(abs, entry.name);
      const childRel = `${ relPrefix }/${ entry.name }`;
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      if (entry.isFile()) {
        try {
          const size = fs.statSync(childAbs).size;
          results.push({ path: childRel, size });
        } catch {
          // skip unreadable entries silently
        }
      }
    }
  };

  walk(root, slug);

  return results;
}

function coreDocFor(kind: KindSingular): string {
  switch (kind) {
  case 'routine': return 'routine.yaml';
  case 'skill': return 'SKILL.md';
  case 'function': return 'function.yaml';
  case 'recipe': return 'manifest.yaml';
  case 'integration': return 'integration.yaml';
  }
}

interface BuiltManifest {
  apiVersion:      'sulla/v3';
  kind:            'Routine' | 'Skill' | 'Function' | 'Recipe' | 'Integration';
  manifestVersion: 1;
  metadata: {
    name:        string;
    description: string;
    version:     string;
    tags:        string[];
    [k: string]: unknown;
  };
  bundle: {
    bundleSchemaVersion: 1;
    totalSize:           number;
    files:               BundleFileEntry[];
  };
  previews: {
    readme?:  string;
    coreDoc?: string;
  };
  [k: string]: unknown;
}

function capitaliseKind(kind: KindSingular): BuiltManifest['kind'] {
  return kind.charAt(0).toUpperCase() + kind.slice(1) as BuiltManifest['kind'];
}

interface BuiltPayload {
  template: {
    id:                   string;
    kind:                 KindSingular;
    slug:                 string;
    name:                 string;
    description:          string | null;
    tagline:              string | null;
    version:              string;
    category:             string | null;
    author_contractor_id: string;
    author_display:       string | null;
    tags:                 string[];
    featured:             boolean;
    hero_media:           null;
    bundle_size:          number;
    download_count:       number;
    created_at:           string;
    updated_at:           string;
    manifest:             Record<string, unknown>;
  };
}

export function buildLocalManifest(kind: KindSingular, slug: string): BuiltPayload | null {
  const itemDir = findItemDir(kind, slug);

  if (!itemDir) return null;

  const coreDocName = coreDocFor(kind);
  const coreDocPath = path.join(itemDir, coreDocName);
  const coreDocText = readTextSafe(coreDocPath);
  const readmeText = readTextSafe(path.join(itemDir, 'README.md'));

  // Gather metadata per kind — same source files the scanners already use.
  let name: string = slug;
  let description = '';
  let version = '1.0.0';
  let category: string | null = null;
  let tags: string[] = [];
  let summaryBlock: Record<string, unknown> | null = null;

  switch (kind) {
  case 'skill': {
    if (coreDocText != null) {
      const fm = parseFrontmatter(coreDocText);
      name = pickString(fm, 'name') ?? slug;
      description = pickString(fm, 'description') ?? '';
      version = pickString(fm, 'version') ?? '1.0.0';
      category = pickString(fm, 'category') ?? null;
      const tagsArr = fm?.tags;
      if (Array.isArray(tagsArr)) tags = tagsArr.map(String);
      const body = coreDocText.startsWith('---')
        ? coreDocText.slice(coreDocText.indexOf('\n---', 3) + 4)
        : coreDocText;
      summaryBlock = {
        skillSummary: {
          skillKey:             pickString(fm, 'skill_key') ?? pickString(fm, 'skillKey') ?? slug,
          category:             category ?? '',
          condition:            pickString(fm, 'condition') ?? '',
          promptLength:         body.trim().length,
          requiredIntegrations: Array.isArray(fm?.required_integrations)
            ? (fm.required_integrations as unknown[]).map(String)
            : [],
        },
      };
    }
    break;
  }
  case 'function': {
    if (coreDocText != null) {
      try {
        const doc = yaml.parse(coreDocText) as Record<string, unknown> | null;
        if (doc) {
          name = pickString(doc, 'name') ?? slug;
          description = pickString(doc, 'description') ?? '';
          version = pickString(doc, 'version') ?? '1.0.0';
          category = pickString(doc, 'category') ?? null;
          const runtime = (pickString(doc, 'runtime') ?? 'python') as 'python' | 'node' | 'shell';
          const inputs = doc.inputs && typeof doc.inputs === 'object' ? doc.inputs as Record<string, unknown> : {};
          const outputs = doc.outputs && typeof doc.outputs === 'object' ? doc.outputs as Record<string, unknown> : {};
          const entrypoint = detectFunctionEntrypoint(itemDir, runtime);
          summaryBlock = {
            functionSummary: {
              functionName:          name,
              runtime,
              inputs:                Object.entries(inputs).map(([k, v]) => ({ name: k, type: typeof (v as any)?.type === 'string' ? (v as any).type : 'string' })),
              outputs:               Object.entries(outputs).map(([k, v]) => ({ name: k, type: typeof (v as any)?.type === 'string' ? (v as any).type : 'string' })),
              entrypoint,
              requiredVaultAccounts: [],
            },
          };
        }
      } catch (err) {
        console.warn(`[Sulla] function ${ slug } has unparseable function.yaml:`, err);
      }
    }
    break;
  }
  case 'recipe': {
    if (coreDocText != null) {
      try {
        const doc = yaml.parse(coreDocText) as Record<string, unknown> | null;
        if (doc) {
          name = pickString(doc, 'name') ?? slug;
          description = pickString(doc, 'description') ?? '';
          version = pickString(doc, 'version') ?? '1.0.0';
          category = pickString(doc, 'category') ?? null;
          const image = readComposeImage(itemDir);
          summaryBlock = {
            recipeSummary: {
              extension:            pickString(doc, 'extension') ?? slug,
              extensionVersion:     pickString(doc, 'extensionVersion') ?? pickString(doc, 'version') ?? '',
              image,
              ports:                readComposePorts(itemDir),
              dependencies:         [],
              configKeys:           Array.isArray(doc.configKeys) ? doc.configKeys.map(String) : [],
              requiredIntegrations: [],
            },
          };
        }
      } catch (err) {
        console.warn(`[Sulla] recipe ${ slug } has unparseable manifest.yaml:`, err);
      }
    }
    break;
  }
  case 'routine': {
    if (coreDocText != null) {
      try {
        const doc = yaml.parse(coreDocText) as Record<string, unknown> | null;
        if (doc) {
          name = pickString(doc, 'name') ?? slug;
          description = pickString(doc, 'description') ?? '';
          version = pickString(doc, 'version') ?? '1.0.0';
          category = pickString(doc, 'category') ?? null;
          const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
          const edges = Array.isArray(doc.edges) ? doc.edges : [];
          const triggerTypes = Array.from(new Set(
            nodes
              .filter((n: any) => n?.data?.category === 'trigger')
              .map((n: any) => n?.data?.subtype || n?.type)
              .filter(Boolean)
              .map(String),
          ));
          summaryBlock = {
            routineSummary: {
              nodeCount:             nodes.length,
              edgeCount:             edges.length,
              triggerTypes,
              requiredIntegrations:  [],
              requiredFunctions:     [],
              requiredVaultAccounts: [],
            },
          };
        }
      } catch (err) {
        console.warn(`[Sulla] routine ${ slug } has unparseable routine.yaml:`, err);
      }
    }
    break;
  }
  case 'integration': {
    if (coreDocText != null) {
      try {
        const doc = yaml.parse(coreDocText) as Record<string, unknown> | null;

        if (doc) {
          name = pickString(doc, 'name') ?? slug;
          description = pickString(doc, 'description') ?? '';
          version = pickString(doc, 'version') ?? '1.0.0';
          category = pickString(doc, 'category') ?? null;

          const bundled = (doc.bundled && typeof doc.bundled === 'object')
            ? doc.bundled as { functions?: unknown; skills?: unknown }
            : null;
          const bundledFunctions = Array.isArray(bundled?.functions) ? bundled.functions.map(String) : [];
          const bundledSkills = Array.isArray(bundled?.skills) ? bundled.skills.map(String) : [];
          const properties = Array.isArray(doc.properties) ? doc.properties : [];

          summaryBlock = {
            integrationSummary: {
              authType:         pickString(doc, 'authType') ?? 'credentials',
              oauthProviderId:  pickString(doc, 'oauthProviderId') ?? null,
              propertyCount:    properties.length,
              bundledFunctions,
              bundledSkills,
              builtin:          doc.builtin === true,
            },
          };
        }
      } catch (err) {
        console.warn(`[Sulla] integration ${ slug } has unparseable integration.yaml:`, err);
      }
    }
    break;
  }
  }

  const files = walkBundleFiles(itemDir, slug);
  const totalSize = files.reduce((n, f) => n + f.size, 0);

  const manifest: BuiltManifest = {
    apiVersion:      'sulla/v3',
    kind:            capitaliseKind(kind),
    manifestVersion: 1,
    metadata:        {
      name,
      description,
      version,
      tags,
      ...(category ? { category } : {}),
    },
    bundle: {
      bundleSchemaVersion: 1,
      totalSize,
      files,
    },
    previews: {
      ...(readmeText ? { readme: readmeText } : {}),
      ...(coreDocText ? { coreDoc: coreDocText } : {}),
    },
    ...(summaryBlock ?? {}),
  };

  const updatedAt = mtimeIso(coreDocPath) || mtimeIso(itemDir);

  return {
    template: {
      id:                    `local:${ kind }:${ slug }`,
      kind,
      slug,
      name,
      description,
      tagline:               null,
      version,
      category,
      author_contractor_id:  'local',
      author_display:        'You',
      tags,
      featured:              false,
      hero_media:            null,
      bundle_size:           totalSize,
      download_count:        0,
      created_at:            updatedAt,
      updated_at:            updatedAt,
      manifest:              manifest as unknown as Record<string, unknown>,
    },
  };
}

function detectFunctionEntrypoint(itemDir: string, runtime: 'python' | 'node' | 'shell'): string {
  const candidates = runtime === 'python' ? ['main.py'] : runtime === 'node' ? ['main.js', 'main.ts'] : ['main.sh'];
  for (const name of candidates) {
    if (fs.existsSync(path.join(itemDir, name))) return name;
  }

  return candidates[0];
}

function readComposePorts(recipeDir: string): number[] {
  const composePath = path.join(recipeDir, 'docker-compose.yml');
  const text = readTextSafe(composePath);
  if (!text) return [];
  try {
    const doc = yaml.parse(text) as { services?: Record<string, { ports?: unknown } | undefined> } | null;
    const services = doc?.services;
    if (!services || typeof services !== 'object') return [];
    const ports = new Set<number>();
    for (const service of Object.values(services)) {
      const arr = service?.ports;
      if (!Array.isArray(arr)) continue;
      for (const p of arr) {
        if (typeof p === 'number') {
          ports.add(p);
        } else if (typeof p === 'string') {
          // "80", "80:80", "127.0.0.1:80:80"
          const match = /(\d+)(?:\s*$|\s*\/)/.exec(p);
          if (match) ports.add(Number(match[1]));
          else {
            const parts = p.split(':');
            const last = parts[parts.length - 1];
            const n = parseInt(last, 10);
            if (!isNaN(n)) ports.add(n);
          }
        }
      }
    }

    return Array.from(ports);
  } catch {
    return [];
  }
}

// ─── IPC registration ───────────────────────────────────────────

export function initSullaLibraryEvents(): void {
  ipcMainProxy.handle('library-list-skills', async() => {
    try {
      return scanSkills();
    } catch (err) {
      console.error('[Sulla] library-list-skills failed:', err);

      return [];
    }
  });

  ipcMainProxy.handle('library-list-recipes', async() => {
    try {
      return scanRecipes();
    } catch (err) {
      console.error('[Sulla] library-list-recipes failed:', err);

      return [];
    }
  });

  ipcMainProxy.handle('library-list-integrations', async() => {
    try {
      return scanIntegrations();
    } catch (err) {
      console.error('[Sulla] library-list-integrations failed:', err);

      return [];
    }
  });

  /**
   * Uninstall a marketplace-installed integration.
   *
   * Removes the integration dir at `~/sulla/integrations/<slug>/` plus any
   * companion functions/skills declared in `integration.yaml`'s `bundled`
   * block (at `~/sulla/functions/<slug>-<name>/` and `~/sulla/skills/<slug>-<name>/`).
   *
   * Refuses to uninstall builtins (`source === 'resources'`) — those are
   * shipped with Sulla Desktop via sulla-resources and the user should not
   * be able to delete them through the UI.
   *
   * Does NOT touch vault credentials — those are purged separately through
   * the integration detail drawer, where the user can see which accounts
   * they'd be blowing away.
   */
  ipcMainProxy.handle('library-uninstall-integration', async(_event, slug: string) => {
    try {
      if (!slug || typeof slug !== 'string') {
        return { uninstalled: false, error: 'library-uninstall-integration requires a slug' };
      }

      const {
        resolveSullaUserIntegrationsDir,
        resolveSullaFunctionsDir,
        resolveSullaUserSkillsDir,
      } = require('@pkg/agent/utils/sullaPaths');

      const integrationDir = path.join(resolveSullaUserIntegrationsDir(), slug);

      if (!fs.existsSync(integrationDir)) {
        return { uninstalled: false, error: `No marketplace integration installed at ${ integrationDir }. Builtins cannot be uninstalled.` };
      }

      // Read the manifest to learn what was fanned out at install time.
      // Missing or malformed manifest is non-fatal — we still remove the dir
      // itself; bundled artifacts would be orphans in that case, which we log.
      const manifestPath = path.join(integrationDir, 'integration.yaml');
      const removed: { functions: string[]; skills: string[] } = { functions: [], skills: [] };
      let bundled: { functions?: string[]; skills?: string[] } | null = null;

      const manifestText = readTextSafe(manifestPath);

      if (manifestText != null) {
        try {
          const parsed = yaml.parse(manifestText) as { bundled?: { functions?: string[]; skills?: string[] } } | null;

          bundled = parsed?.bundled ?? null;
        } catch (err) {
          console.warn(`[Sulla] integration ${ slug } has unparseable integration.yaml — bundled artifacts may be orphaned:`, err);
        }
      }

      for (const name of bundled?.functions ?? []) {
        const target = path.join(resolveSullaFunctionsDir(), `${ slug }-${ name }`);

        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
          removed.functions.push(`${ slug }-${ name }`);
        }
      }
      for (const name of bundled?.skills ?? []) {
        const target = path.join(resolveSullaUserSkillsDir(), `${ slug }-${ name }`);

        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
          removed.skills.push(`${ slug }-${ name }`);
        }
      }

      fs.rmSync(integrationDir, { recursive: true, force: true });

      console.log(`[Sulla] Uninstalled integration "${ slug }" (+${ removed.functions.length } function(s), +${ removed.skills.length } skill(s))`);

      return {
        uninstalled:      true,
        slug,
        removedFunctions: removed.functions,
        removedSkills:    removed.skills,
      };
    } catch (err) {
      console.error('[Sulla] library-uninstall-integration failed:', err);

      return { uninstalled: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMainProxy.handle('library-reveal', async(_event, kind, slug) => {
    try {
      // Integrations live in two locations — prefer user (marketplace install
      // or fork) over resources (builtin) so "reveal" surfaces the file the
      // user is actually editing.
      const candidates: string[] = (() => {
        const paths = require('@pkg/agent/utils/sullaPaths');

        switch (kind) {
        case 'routines': return [paths.resolveSullaRoutinesDir()];
        case 'skills': return [paths.resolveSullaUserSkillsDir()];
        case 'functions': return [paths.resolveSullaFunctionsDir()];
        case 'recipes': return [paths.resolveSullaRecipesDir()];
        case 'integrations': return [paths.resolveSullaUserIntegrationsDir(), paths.resolveSullaIntegrationsDir()];
        default: return [];
        }
      })();
      if (candidates.length === 0) return { revealed: false, error: `unknown kind "${ kind }"` };

      const target = candidates.map(base => path.join(base, slug)).find(fs.existsSync);

      if (!target) {
        return { revealed: false, error: `path does not exist: ${ candidates.map(b => path.join(b, slug)).join(' or ') }` };
      }
      // openPath opens the folder itself; showItemInFolder selects it in the parent.
      // We want the former — the user is navigating into the item.
      const err = await shell.openPath(target);
      if (err) return { revealed: false, error: err, path: target };

      return { revealed: true, path: target };
    } catch (err) {
      return { revealed: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMainProxy.handle('library-read-manifest', async(_event, kind, slug) => {
    try {
      const singular = KIND_TO_SINGULAR[kind];
      if (!singular) return { error: `unknown kind "${ kind }"` };

      const payload = buildLocalManifest(singular, slug);
      if (!payload) {
        return { error: `no library item at ${ kind }/${ slug }` };
      }

      return payload as any;
    } catch (err) {
      console.error('[Sulla] library-read-manifest failed:', err);

      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  console.log('[Sulla] Library IPC handlers initialized');
}
