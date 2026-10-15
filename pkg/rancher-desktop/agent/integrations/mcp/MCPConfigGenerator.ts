/**
 * MCPConfigGenerator — converts MCP tool definitions from listTools()
 * into YAML integration config files so they can be loaded by
 * IntegrationConfigLoader and used through the standard ConfigApiClient.
 *
 * Each MCP server account gets its own integration directory:
 *   ~/sulla/integrations/mcp-{accountId}/
 *     mcp-{accountId}.v1-auth.yaml   <- auth config with transport: mcp
 *     {tool-name}.v1.yaml            <- one endpoint per MCP tool
 */

import yaml from 'yaml';

import { postgresClient } from '../../database/PostgresClient';

import type { MCPToolDefinition } from './MCPClient';

const LOG = '[MCPConfigGenerator]';

/** Slug prefix for MCP-generated integration directories */
export const MCP_DIR_PREFIX = 'mcp-';

export interface GenerateResult {
  /** Integration directory name (e.g. "mcp-my-server") */
  dirName:       string;
  /** Absolute path to the generated directory */
  dirPath:       string;
  /** Number of endpoint YAML files written */
  endpointCount: number;
  /** Tool names that were written */
  toolNames:     string[];
}

export interface DiffResult {
  added:   string[];
  removed: string[];
  changed: string[];
}

/**
 * Generate YAML integration configs from MCP tool definitions.
 */
export async function generateConfigs(
  accountId:    string,
  accountLabel: string,
  serverUrl:    string,
  tools:        MCPToolDefinition[],
): Promise<GenerateResult> {
  const dirName = `${ MCP_DIR_PREFIX }${ sanitizeSlug(accountId) }`;
  const authConfig = buildAuthYaml(accountId, accountLabel, serverUrl);
  const authFileName = `${ dirName }.v1-auth.yaml`;
  const files: Record<string, string> = { [authFileName]: yaml.stringify(authConfig) };

  // Write one endpoint file per tool
  const toolNames: string[] = [];
  for (const tool of tools) {
    const epConfig = buildEndpointYaml(tool);
    const epFileName = `${ sanitizeSlug(tool.name) }.v1.yaml`;
    files[epFileName] = yaml.stringify(epConfig);
    toolNames.push(tool.name);
  }

  const manifest = {
    apiVersion:  'sulla/v1',
    kind:        'Integration',
    id:          dirName,
    name:        accountLabel,
    description: `MCP tools for ${ accountLabel }`,
    category:    'Developer Tools',
    version:     '1.0.0',
    lastUpdated: new Date().toISOString(),
    developer:   'MCP',
    sort:        0,
    paid:        false,
    beta:        false,
    comingSoon:  false,
    builtin:     false,
  };
  await postgresClient.query(`INSERT INTO integration_definitions
    (slug,name,description,manifest,files,source_kind,version,user_edited)
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,'user','1.0.0',false)
    ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,manifest=EXCLUDED.manifest,files=EXCLUDED.files,updated_at=now()`,
  [dirName, accountLabel, manifest.description, JSON.stringify(manifest), JSON.stringify(files)]);
  console.log(`${ LOG } Stored ${ tools.length } endpoint(s) for "${ accountId }" in Postgres`);

  return { dirName, dirPath: `database:integration_definitions/${ dirName }`, endpointCount: tools.length, toolNames };
}

/**
 * Remove a generated integration directory for an MCP account.
 */
export async function removeConfigs(accountId: string): Promise<boolean> {
  const dirName = `${ MCP_DIR_PREFIX }${ sanitizeSlug(accountId) }`;
  const rows = await postgresClient.query(`DELETE FROM integration_definitions WHERE slug=$1 RETURNING slug`, [dirName]);
  return rows.length > 0;
}

/**
 * Diff current tools against what's on disk to show added/removed/changed.
 */
export async function diffConfigs(
  accountId: string,
  tools:     MCPToolDefinition[],
): Promise<DiffResult> {
  const dirName = `${ MCP_DIR_PREFIX }${ sanitizeSlug(accountId) }`;
  const onDisk = new Set<string>();
  const row = await postgresClient.queryOne(`SELECT files FROM integration_definitions WHERE slug=$1`, [dirName]);
  const files = row?.files && typeof row.files === 'object' ? row.files : {};
  for (const [f, raw] of Object.entries(files)) {
    if (f.endsWith('-auth.yaml')) continue;
    if (f.endsWith('.yaml') || f.endsWith('.yml')) {
      try {
        const parsed = yaml.parse(String(raw));
        if (parsed?.endpoint?.name) onDisk.add(parsed.endpoint.name);
      } catch { /* skip unparseable files */ }
    }
  }

  const incoming = new Set(tools.map(t => t.name));

  const added:   string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const name of incoming) {
    if (!onDisk.has(name)) {
      added.push(name);
    }
    // We could do deep-diff of inputSchema here, but for now just track presence
  }
  for (const name of onDisk) {
    if (!incoming.has(name)) {
      removed.push(name);
    }
  }

  return { added, removed, changed };
}

/**
 * Check if an integration directory name is an MCP-generated one.
 */
export function isMCPGeneratedDir(dirName: string): boolean {
  return dirName.startsWith(MCP_DIR_PREFIX);
}

// ── Private helpers ─────────────────────────────────────────────

function buildAuthYaml(accountId: string, accountLabel: string, serverUrl: string): Record<string, any> {
  return {
    api: {
      name:      `mcp-${ sanitizeSlug(accountId) }`,
      version:   'v1',
      provider:  'mcp',
      base_url:  serverUrl,
      transport: 'mcp',
    },
    mcp: {
      account_id: accountId,
      synced_at:  new Date().toISOString(),
    },
    auth: {
      type:                    'bearer',
      client_secret:           '$' + '{MCP_AUTH_TOKEN}',
      token_storage:           'local',
      refresh_automatically:   false,
    },
  };
}

function buildEndpointYaml(tool: MCPToolDefinition): Record<string, any> {
  const config: Record<string, any> = {
    endpoint: {
      name:        tool.name,
      description: tool.description || `MCP tool: ${ tool.name }`,
      path:        '/tools/call',
      method:      'POST',
      auth:        'required',
      transport:   'mcp',
    },
  };

  // Convert inputSchema.properties → body_params
  if (tool.inputSchema?.properties && Object.keys(tool.inputSchema.properties).length > 0) {
    const required = new Set(tool.inputSchema.required || []);
    const bodyParams: Record<string, any> = {};

    for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
      const s = schema;
      const param: Record<string, any> = {
        type:     s.type || 'string',
        required: required.has(name),
      };
      if (s.description) param.description = s.description;
      if (s.default !== undefined) param.default = s.default;
      if (s.enum) param.enum = s.enum;
      if (s.minimum !== undefined) param.min = s.minimum;
      if (s.maximum !== undefined) param.max = s.maximum;

      bodyParams[name] = param;
    }

    config.body_params = bodyParams;
  }

  return config;
}

/**
 * Sanitize a string for use as a file/directory name slug.
 */
function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
