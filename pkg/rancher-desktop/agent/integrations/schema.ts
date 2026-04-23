/**
 * Schema + validator for integration.yaml manifests.
 *
 * An integration package is a directory on disk:
 *
 *   <root>/<slug>/
 *     integration.yaml      # manifest (this schema)
 *     <icon>                # referenced by manifest.icon
 *     functions/            # optional bundled functions (installed to ~/sulla/functions/<slug>-<name>/)
 *       <name>/function.yaml
 *     skills/               # optional bundled skills (installed to ~/sulla/skills/<slug>-<name>/)
 *       <name>/SKILL.md
 *
 * The manifest shape mirrors the Integration TS interface 1:1, with three deltas:
 *   - `connected` is removed (runtime state derived from vault, not manifest).
 *   - `builtin` is added (true for shipped defaults, false for marketplace installs).
 *   - `bundled` is added (lists companion functions/skills to install alongside).
 */

import type { Integration } from './types';

/**
 * Fixed category enum. Values are display strings (match the existing `category`
 * field in native/*.ts so migration is a mechanical copy). The slug forms
 * (snake_case) map 1:1 to the native/ filenames.
 */
export const INTEGRATION_CATEGORIES = [
  'AI Infrastructure',
  'AI & ML',
  'Analytics',
  'Automation',
  'Communication',
  'CRM & Sales',
  'Customer Support',
  'Database',
  'Design',
  'Developer Tools',
  'E-Commerce',
  'File Storage',
  'Finance',
  'HR & Recruiting',
  'Marketing',
  'Paid Ads',
  'Productivity',
  'Project Management',
  'Security',
  'Social Media',
] as const;

export type IntegrationCategory = typeof INTEGRATION_CATEGORIES[number];

/** Slug form of each category, used for filesystem/URL contexts. */
export const CATEGORY_SLUGS: Record<IntegrationCategory, string> = {
  'AI Infrastructure':  'ai_infrastructure',
  'AI & ML':            'ai_ml',
  Analytics:            'analytics',
  Automation:           'automation',
  Communication:        'communication',
  'CRM & Sales':        'crm_sales',
  'Customer Support':   'customer_support',
  Database:             'database',
  Design:               'design',
  'Developer Tools':    'developer_tools',
  'E-Commerce':         'ecommerce',
  'File Storage':       'file_storage',
  Finance:              'finance',
  'HR & Recruiting':    'hr_recruiting',
  Marketing:            'marketing',
  'Paid Ads':           'paid_ads',
  Productivity:         'productivity',
  'Project Management': 'project_management',
  Security:             'security',
  'Social Media':       'social_media',
};

/** Manifest shape as it lives on disk. `Integration` minus runtime state, plus bundling. */
export interface IntegrationManifest {
  apiVersion: 'sulla/v1';
  kind:       'Integration';

  // Identity
  id:          string;
  name:        string;
  description: string;
  category:    IntegrationCategory;
  icon?:       string;
  version:     string;
  lastUpdated: string;
  developer:   string;
  sort:        number;

  // Status flags
  paid:       boolean;
  beta:       boolean;
  comingSoon: boolean;

  /**
   * True for integrations shipped with Sulla Desktop (migrated from native/*.ts).
   * False for integrations installed from the marketplace. Builtins cannot be
   * uninstalled by the user; marketplace installs can.
   */
  builtin: boolean;

  // Auth
  authType?:          'credentials' | 'oauth';
  oauth?:             boolean;
  oauthProviderId?:   string;
  sullaManagedOAuth?: boolean;

  // Documentation
  formGuide?:         string;
  installationGuide?: Integration['installationGuide'];
  media?:             Integration['media'];
  features?:          Integration['features'];
  guideLinks?:        Integration['guideLinks'];
  properties?:        Integration['properties'];

  /**
   * Companion artifacts bundled with the integration. At install time these are
   * fanned out to their respective runtime locations:
   *   functions[i] → ~/sulla/functions/<integration.id>-<functions[i]>/
   *   skills[i]    → ~/sulla/skills/<integration.id>-<skills[i]>/
   *
   * Each name references a subdirectory of functions/ or skills/ in the
   * integration package (e.g. functions: ['send'] → package has functions/send/function.yaml).
   */
  bundled?: {
    functions?: string[];
    skills?:    string[];
  };
}

export interface ValidationResult {
  valid:  boolean;
  errors: string[];
  data?:  IntegrationManifest;
}

// Slugs are filesystem dir names and vault keys. Allow snake_case and kebab-case
// (existing catalog mixes both: `microsoft_teams` vs `claude-code`) but reject
// uppercase/spaces/dots so the filesystem stays clean.
const SLUG_PATTERN = /^[a-z][a-z0-9_-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const VALID_CATEGORIES = new Set<string>(INTEGRATION_CATEGORIES);
const VALID_PROP_TYPES = new Set(['text', 'password', 'url', 'select']);
const VALID_AUTH_TYPES = new Set(['credentials', 'oauth']);
const VALID_MEDIA_TYPES = new Set(['youtube', 'image']);

/**
 * Validate a parsed integration.yaml object.
 *
 * @param raw       Parsed YAML object.
 * @param expectedId Optional — when provided (typically the directory name),
 *                   the manifest's `id` must match. This catches rename drift.
 */
export function validateIntegrationManifest(raw: unknown, expectedId?: string): ValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['manifest must be an object'] };
  }

  const m = raw as Record<string, unknown>;

  // Envelope
  if (m.apiVersion !== 'sulla/v1') errors.push(`apiVersion must be "sulla/v1" (got ${ JSON.stringify(m.apiVersion) })`);
  if (m.kind !== 'Integration') errors.push(`kind must be "Integration" (got ${ JSON.stringify(m.kind) })`);

  // Identity
  requireString(m, 'id', errors);
  if (typeof m.id === 'string' && !SLUG_PATTERN.test(m.id)) {
    errors.push(`id must be snake_case ascii (got ${ JSON.stringify(m.id) })`);
  }
  if (expectedId && m.id !== expectedId) {
    errors.push(`id "${ String(m.id) }" does not match directory "${ expectedId }"`);
  }

  requireString(m, 'name', errors);
  requireString(m, 'description', errors);
  requireString(m, 'developer', errors);
  requireString(m, 'lastUpdated', errors);

  if (typeof m.version !== 'string' || !VERSION_PATTERN.test(m.version)) {
    errors.push(`version must be semver x.y.z (got ${ JSON.stringify(m.version) })`);
  }

  if (typeof m.category !== 'string' || !VALID_CATEGORIES.has(m.category)) {
    errors.push(`category must be one of [${ [...VALID_CATEGORIES].map(c => `"${ c }"`).join(', ') }] (got ${ JSON.stringify(m.category) })`);
  }

  if (typeof m.sort !== 'number' || !Number.isFinite(m.sort)) {
    errors.push(`sort must be a number (got ${ JSON.stringify(m.sort) })`);
  }

  if (m.icon !== undefined && typeof m.icon !== 'string') {
    errors.push('icon must be a string if provided');
  }

  // Status flags
  requireBoolean(m, 'paid', errors);
  requireBoolean(m, 'beta', errors);
  requireBoolean(m, 'comingSoon', errors);
  requireBoolean(m, 'builtin', errors);

  // Auth
  if (m.authType !== undefined && (typeof m.authType !== 'string' || !VALID_AUTH_TYPES.has(m.authType))) {
    errors.push(`authType must be "credentials" or "oauth" if provided (got ${ JSON.stringify(m.authType) })`);
  }
  if (m.oauth !== undefined && typeof m.oauth !== 'boolean') {
    errors.push('oauth must be boolean if provided');
  }
  if (m.oauthProviderId !== undefined && typeof m.oauthProviderId !== 'string') {
    errors.push('oauthProviderId must be a string if provided');
  }
  if (m.sullaManagedOAuth !== undefined && typeof m.sullaManagedOAuth !== 'boolean') {
    errors.push('sullaManagedOAuth must be boolean if provided');
  }
  if ((m.authType === 'oauth' || m.oauth === true) && typeof m.oauthProviderId !== 'string') {
    errors.push('oauthProviderId is required when authType is "oauth" or oauth is true');
  }

  // Documentation blocks
  if (m.formGuide !== undefined && typeof m.formGuide !== 'string') {
    errors.push('formGuide must be a string if provided');
  }
  if (m.installationGuide !== undefined) validateInstallationGuide(m.installationGuide, errors);
  if (m.media !== undefined) validateMedia(m.media, errors);
  if (m.features !== undefined) validateFeatures(m.features, errors);
  if (m.guideLinks !== undefined) validateGuideLinks(m.guideLinks, errors);
  if (m.properties !== undefined) validateProperties(m.properties, errors);

  // Bundled companions
  if (m.bundled !== undefined) validateBundled(m.bundled, errors);

  return errors.length === 0
    ? { valid: true, errors: [], data: m as unknown as IntegrationManifest }
    : { valid: false, errors };
}

// ── field helpers ─────────────────────────────────────────────────────────────

function requireString(m: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof m[key] !== 'string' || (m[key]).length === 0) {
    errors.push(`${ key } must be a non-empty string (got ${ JSON.stringify(m[key]) })`);
  }
}

function requireBoolean(m: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof m[key] !== 'boolean') {
    errors.push(`${ key } must be a boolean (got ${ JSON.stringify(m[key]) })`);
  }
}

function validateInstallationGuide(v: unknown, errors: string[]): void {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    errors.push('installationGuide must be an object');

    return;
  }
  const g = v as Record<string, unknown>;

  if (typeof g.title !== 'string') errors.push('installationGuide.title must be a string');
  if (typeof g.description !== 'string') errors.push('installationGuide.description must be a string');
  if (!Array.isArray(g.steps)) {
    errors.push('installationGuide.steps must be an array');
  } else {
    g.steps.forEach((s, i) => {
      if (!s || typeof s !== 'object') {
        errors.push(`installationGuide.steps[${ i }] must be an object`);

        return;
      }
      const step = s as Record<string, unknown>;

      if (typeof step.title !== 'string') errors.push(`installationGuide.steps[${ i }].title must be a string`);
      if (typeof step.content !== 'string') errors.push(`installationGuide.steps[${ i }].content must be a string`);
    });
  }
  if (g.importantNotes !== undefined) {
    if (!Array.isArray(g.importantNotes) || !g.importantNotes.every(n => typeof n === 'string')) {
      errors.push('installationGuide.importantNotes must be an array of strings');
    }
  }
}

function validateMedia(v: unknown, errors: string[]): void {
  if (!Array.isArray(v)) {
    errors.push('media must be an array');

    return;
  }
  v.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      errors.push(`media[${ i }] must be an object`);

      return;
    }
    const media = item as Record<string, unknown>;

    if (typeof media.type !== 'string' || !VALID_MEDIA_TYPES.has(media.type)) {
      errors.push(`media[${ i }].type must be "youtube" or "image"`);
    }
    if (typeof media.url !== 'string') errors.push(`media[${ i }].url must be a string`);
    if (typeof media.alt !== 'string') errors.push(`media[${ i }].alt must be a string`);
    if (media.caption !== undefined && typeof media.caption !== 'string') {
      errors.push(`media[${ i }].caption must be a string if provided`);
    }
  });
}

function validateFeatures(v: unknown, errors: string[]): void {
  if (!Array.isArray(v)) {
    errors.push('features must be an array');

    return;
  }
  v.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      errors.push(`features[${ i }] must be an object`);

      return;
    }
    const f = item as Record<string, unknown>;

    if (typeof f.title !== 'string') errors.push(`features[${ i }].title must be a string`);
    if (typeof f.description !== 'string') errors.push(`features[${ i }].description must be a string`);
  });
}

function validateGuideLinks(v: unknown, errors: string[]): void {
  if (!Array.isArray(v)) {
    errors.push('guideLinks must be an array');

    return;
  }
  v.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      errors.push(`guideLinks[${ i }] must be an object`);

      return;
    }
    const link = item as Record<string, unknown>;

    if (typeof link.title !== 'string') errors.push(`guideLinks[${ i }].title must be a string`);
    if (typeof link.description !== 'string') errors.push(`guideLinks[${ i }].description must be a string`);
    if (typeof link.url !== 'string') errors.push(`guideLinks[${ i }].url must be a string`);
  });
}

function validateProperties(v: unknown, errors: string[]): void {
  if (!Array.isArray(v)) {
    errors.push('properties must be an array');

    return;
  }
  v.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      errors.push(`properties[${ i }] must be an object`);

      return;
    }
    const p = item as Record<string, unknown>;

    if (typeof p.key !== 'string') errors.push(`properties[${ i }].key must be a string`);
    if (typeof p.title !== 'string') errors.push(`properties[${ i }].title must be a string`);
    if (typeof p.hint !== 'string') errors.push(`properties[${ i }].hint must be a string`);
    if (typeof p.placeholder !== 'string') errors.push(`properties[${ i }].placeholder must be a string`);
    if (typeof p.required !== 'boolean') errors.push(`properties[${ i }].required must be a boolean`);
    if (typeof p.type !== 'string' || !VALID_PROP_TYPES.has(p.type)) {
      errors.push(`properties[${ i }].type must be one of text|password|url|select`);
    }
    if (p.type === 'select' && typeof p.selectBoxId !== 'string') {
      errors.push(`properties[${ i }].selectBoxId is required when type is "select"`);
    }
    if (p.selectDependsOn !== undefined) {
      if (!Array.isArray(p.selectDependsOn) || !p.selectDependsOn.every(k => typeof k === 'string')) {
        errors.push(`properties[${ i }].selectDependsOn must be an array of strings`);
      }
    }
    if (p.validation !== undefined) {
      if (!p.validation || typeof p.validation !== 'object') {
        errors.push(`properties[${ i }].validation must be an object`);
      } else {
        const val = p.validation as Record<string, unknown>;

        if (val.pattern !== undefined && typeof val.pattern !== 'string') errors.push(`properties[${ i }].validation.pattern must be a string`);
        if (val.minLength !== undefined && typeof val.minLength !== 'number') errors.push(`properties[${ i }].validation.minLength must be a number`);
        if (val.maxLength !== undefined && typeof val.maxLength !== 'number') errors.push(`properties[${ i }].validation.maxLength must be a number`);
      }
    }
  });
}

function validateBundled(v: unknown, errors: string[]): void {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    errors.push('bundled must be an object');

    return;
  }
  const b = v as Record<string, unknown>;

  if (b.functions !== undefined) {
    if (!Array.isArray(b.functions) || !b.functions.every(n => typeof n === 'string' && SLUG_PATTERN.test(n))) {
      errors.push('bundled.functions must be an array of snake_case slugs');
    }
  }
  if (b.skills !== undefined) {
    if (!Array.isArray(b.skills) || !b.skills.every(n => typeof n === 'string' && SLUG_PATTERN.test(n))) {
      errors.push('bundled.skills must be an array of snake_case slugs');
    }
  }
}

/**
 * Convert a validated manifest into a runtime `Integration` record
 * (adds `connected: false` — callers fill this in from vault state).
 */
export function manifestToIntegration(m: IntegrationManifest): Integration {
  return {
    id:                m.id,
    name:              m.name,
    description:       m.description,
    category:          m.category,
    icon:              m.icon,
    paid:              m.paid,
    sort:              m.sort,
    beta:              m.beta,
    comingSoon:        m.comingSoon,
    connected:         false,
    version:           m.version,
    lastUpdated:       m.lastUpdated,
    developer:         m.developer,
    authType:          m.authType,
    oauth:             m.oauth,
    oauthProviderId:   m.oauthProviderId,
    sullaManagedOAuth: m.sullaManagedOAuth,
    formGuide:         m.formGuide,
    installationGuide: m.installationGuide,
    media:             m.media,
    features:          m.features,
    guideLinks:        m.guideLinks,
    properties:        m.properties,
  };
}
