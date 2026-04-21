import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  NODE_REGISTRY,
  type NodeTypeDefinition,
} from '@pkg/pages/editor/workflow/nodeRegistry';
import type { WorkflowNodeCategory } from '@pkg/pages/editor/workflow/types';

export type RoutineAvatarType = 'trigger' | 'agent' | 'tool' | 'logic' | 'loop' | 'default';

export interface RoutineLibraryItem {
  /** Unique slug: same as registry subtype */
  id:          string;
  /** Registry subtype — persisted on dropped nodes */
  subtype:     string;
  category:    WorkflowNodeCategory;
  /** Short code shown in the card stub, e.g. "T-01" */
  code:        string;
  /** Avatar gradient bucket */
  avatarType:  RoutineAvatarType;
  /** 2-char initials for the avatar */
  initials:    string;
  /** Top kicker shown above the title */
  kicker:      string;
  /** Display name */
  name:        string;
  /** Subtitle below the name */
  role:        string;
  /** Italic personality quote */
  quote:       string;
}

function initialsFrom(label: string): string {
  const words = label.split(/[\s\-]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return words[0].slice(0, 2).toUpperCase();
}

function avatarFor(def: NodeTypeDefinition): RoutineAvatarType {
  if (def.category === 'trigger') return 'trigger';
  if (def.subtype === 'tool-call' || def.subtype === 'integration-call') return 'tool';
  if (def.category === 'agent') return 'agent';
  if (def.subtype === 'loop') return 'loop';
  if (def.category === 'routing' || def.category === 'flow-control') return 'logic';
  return 'default';
}

function kickerFor(def: NodeTypeDefinition): string {
  if (def.category === 'trigger') return 'Trigger';
  if (def.subtype === 'tool-call') return 'Tool';
  if (def.subtype === 'integration-call') return 'Integration';
  if (def.category === 'agent') return 'Agent';
  if (def.category === 'routing') return 'Routing';
  if (def.category === 'flow-control') return 'Flow';
  if (def.category === 'io') return 'I/O';
  return 'Node';
}

function codePrefix(category: WorkflowNodeCategory): string {
  switch (category) {
  case 'trigger':      return 'T';
  case 'agent':        return 'A';
  case 'routing':      return 'R';
  case 'flow-control': return 'F';
  case 'io':           return 'O';
  default:             return 'N';
  }
}

/** Everything below derives once from NODE_REGISTRY — no runtime duplication. */
function buildLibrary(): RoutineLibraryItem[] {
  const perCategoryIndex: Record<string, number> = {};

  return NODE_REGISTRY.map((def) => {
    perCategoryIndex[def.category] = (perCategoryIndex[def.category] ?? 0) + 1;
    const idx = perCategoryIndex[def.category];
    const code = `${ codePrefix(def.category) }-${ String(idx).padStart(2, '0') }`;

    return {
      id:         def.subtype,
      subtype:    def.subtype,
      category:   def.category,
      code,
      avatarType: avatarFor(def),
      initials:   initialsFrom(def.label),
      kicker:     kickerFor(def),
      name:       def.label,
      role:       def.description,
      quote:      `"${ def.description }"`,
    };
  });
}

export const ROUTINE_LIBRARY: RoutineLibraryItem[] = buildLibrary();

/** Grouped by category in the display order the editor uses. */
export const ROUTINE_LIBRARY_BY_CATEGORY: Array<{
  category: WorkflowNodeCategory;
  label:    string;
  items:    RoutineLibraryItem[];
}> = CATEGORY_ORDER.map(category => ({
  category,
  label: CATEGORY_LABELS[category],
  items: ROUTINE_LIBRARY.filter(item => item.category === category),
}));

export function findLibraryItem(subtype: string): RoutineLibraryItem | undefined {
  return ROUTINE_LIBRARY.find(i => i.id === subtype);
}

/**
 * Build the `data` payload for a RoutineNode instance dropped onto the canvas
 * from a library item. Pulls the registry's `defaultConfig()` so the right-hand
 * config panel has something real to edit.
 */
export function makeRoutineNodeData(item: RoutineLibraryItem): Record<string, unknown> {
  const def = NODE_REGISTRY.find(n => n.subtype === item.subtype);

  return {
    state:       'idle',
    nodeCode:    item.code,
    kicker:      item.kicker,
    title:       item.name,
    role:        item.role,
    quote:       item.quote,
    subtype:     item.subtype,
    category:    item.category,
    label:       def?.defaultLabel ?? item.name,
    config:      def?.defaultConfig() ?? {},
    avatar:      { type: item.avatarType, initials: item.initials },
    footerRight: '—',
  };
}

// ═════════════════════════════════════════════════════════════════════════
// Display enrichment for loaded nodes
// -------------------------------------------------------------------------
// Nodes that come off the wire (DB load, template instantiation, legacy
// saves) may be missing the presentational fields RoutineNode.vue reads —
// `nodeCode`, `avatar`, `kicker`, `state`. This helper fills them in from
// the category + title so every node renders with a label, a positional
// code, and an avatar circle.
//
// Semantics: **only fills missing fields**. If the node already carries
// display data (e.g. the hardcoded demo graph, or a user-customised node),
// it is left untouched. That keeps the enrichment idempotent — running it
// twice does nothing the second time — and prevents the save watcher from
// ping-ponging after every load.
// ═════════════════════════════════════════════════════════════════════════

/** Shape we care about here — matches what VueFlow hands us. */
interface NodeLike {
  id?:       string;
  position?: { x: number; y: number };
  data?:     Record<string, unknown>;
}

function kickerForCategory(category: string): string {
  switch (category) {
  case 'trigger':      return 'Trigger';
  case 'agent':        return 'Agent';
  case 'routing':      return 'Routing';
  case 'flow-control': return 'Flow';
  case 'io':           return 'I/O';
  default:             return 'Node';
  }
}

/** Generic fallback role when the node data doesn't carry one. */
function roleForCategory(category: string): string {
  switch (category) {
  case 'trigger':      return 'Starts the flow.';
  case 'agent':        return 'Performs work in the flow.';
  case 'routing':      return 'Picks a path based on conditions.';
  case 'flow-control': return 'Coordinates timing and branching.';
  case 'io':           return 'Reads or writes external data.';
  default:             return '';
  }
}

function avatarDefault(category: string, title: string): Record<string, unknown> {
  if (category === 'trigger') {
    return { type: 'trigger', icon: '⚡' };
  }

  const type = category === 'agent' ? 'agent'
    : category === 'routing' || category === 'flow-control' ? 'logic'
      : category === 'tool' ? 'tool'
        : 'default';

  return { type, initials: initialsFrom(title || 'Node') };
}

export function enrichNodesForDisplay(nodes: NodeLike[]): void {
  // Walk nodes in left-to-right reading order so the positional index
  // inside each category reflects the visual layout. Assigning from a
  // sorted copy leaves the caller's node array order undisturbed.
  const sorted = [...nodes].sort((a, b) => {
    const ax = a.position?.x ?? 0;
    const bx = b.position?.x ?? 0;

    return ax - bx;
  });

  const perCategoryIndex: Record<string, number> = {};

  for (const node of sorted) {
    if (!node.data) node.data = {};
    const data = node.data;
    const category = String(data.category ?? '');
    const title = String(data.title ?? data.label ?? 'Node');

    if (!data.nodeCode) {
      perCategoryIndex[category] = (perCategoryIndex[category] ?? 0) + 1;
      const idx = perCategoryIndex[category];
      data.nodeCode = `${ codePrefix(category as WorkflowNodeCategory) }-${ String(idx).padStart(2, '0') }`;
    } else {
      // Keep the existing code but still bump the counter so subsequent
      // auto-assigned codes in the same category don't collide.
      perCategoryIndex[category] = (perCategoryIndex[category] ?? 0) + 1;
    }

    if (!data.avatar) data.avatar = avatarDefault(category, title);
    if (!data.kicker) data.kicker = kickerForCategory(category);
    if (!data.role) {
      // Only inject a fallback when the category offers a meaningful
      // one — "" would render as a blank line; omitting the field lets
      // the v-if in RoutineNode skip the slot entirely.
      const fallback = roleForCategory(category);
      if (fallback) data.role = fallback;
    }
    if (!data.state) data.state = 'idle';
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Integrations — second-level nav under "Integrations" in the drawer.
// ═════════════════════════════════════════════════════════════════════════

export interface Integration {
  id:          string;
  name:        string;
  description: string;
  category:    string;
  icon?:       string;
  version?:    string;
  [k: string]: unknown;
}

/** Canonical list of integration categories, mirrors AgentIntegrations. */
export const INTEGRATION_CATEGORIES = [
  'AI Infrastructure',
  'Communication',
  'Productivity',
  'Project Management',
  'Developer Tools',
  'CRM & Sales',
  'Customer Support',
  'Marketing',
  'Finance',
  'File Storage',
  'Social Media',
  'E-Commerce',
  'HR & Recruiting',
  'Analytics',
  'Automation',
  'Design',
  'AI & ML',
  'Database',
] as const;

const INTEGRATION_CATEGORY_FILE: Record<string, string> = {
  Communication:        'communication',
  Productivity:         'productivity',
  'Project Management': 'project_management',
  'Developer Tools':    'developer_tools',
  'CRM & Sales':        'crm_sales',
  'Customer Support':   'customer_support',
  Marketing:            'marketing',
  Finance:              'finance',
  'File Storage':       'file_storage',
  'Social Media':       'social_media',
  'E-Commerce':         'ecommerce',
  'HR & Recruiting':    'hr_recruiting',
  Analytics:            'analytics',
  Automation:           'automation',
  Design:               'design',
  'AI & ML':            'ai_ml',
  Database:             'database',
  'AI Infrastructure':  'ai_infrastructure',
};

const integrationCategoryCache = new Map<string, Integration[]>();

/** Lazy-load integrations for a category. Uses the same native files the editor pulls from. */
export async function loadIntegrationsFor(categoryName: string): Promise<Integration[]> {
  if (integrationCategoryCache.has(categoryName)) {
    return integrationCategoryCache.get(categoryName)!;
  }

  const slug = INTEGRATION_CATEGORY_FILE[categoryName];
  if (!slug) return [];

  try {
    const mod = await import(`@pkg/agent/integrations/native/${ slug }.ts`);
    const entries = (Object.values(mod)[0] as Record<string, Integration>) || {};
    const list = Object.values(entries).sort((a, b) => a.name.localeCompare(b.name));
    integrationCategoryCache.set(categoryName, list);

    return list;
  } catch {
    integrationCategoryCache.set(categoryName, []);

    return [];
  }
}

function initialsFromIntegration(name: string): string {
  return initialsFrom(name);
}

/**
 * Build a RoutineNode `data` payload from a selected integration. Always
 * creates an `integration-call` node so the right-hand config panel opens
 * the integration configurator with the slug pre-selected.
 */
export function makeIntegrationNodeData(integration: Integration): Record<string, unknown> {
  const def = NODE_REGISTRY.find(n => n.subtype === 'integration-call');
  const baseConfig = (def?.defaultConfig() ?? {}) as Record<string, unknown>;

  return {
    state:       'idle',
    nodeCode:    `I-${ integration.id.slice(0, 3).toUpperCase() }`,
    kicker:      'Integration',
    title:       integration.name,
    role:        integration.category,
    quote:       `"${ integration.description }"`,
    subtype:     'integration-call',
    category:    'agent',
    label:       integration.name,
    config:      {
      ...baseConfig,
      integrationSlug: integration.id,
      accountId:       'default',
    },
    avatar:      { type: 'tool', initials: initialsFromIntegration(integration.name) },
    footerRight: '—',
  };
}
