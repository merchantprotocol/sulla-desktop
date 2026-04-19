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

import fs from 'node:fs';
import path from 'node:path';

import yaml from 'yaml';

import { resolveSullaIntegrationsDir } from '../../utils/sullaPaths';

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
export function generateConfigs(
  accountId:    string,
  accountLabel: string,
  serverUrl:    string,
  tools:        MCPToolDefinition[],
  integrationsDir?: string,
): GenerateResult {
  const baseDir = integrationsDir || resolveSullaIntegrationsDir();
  const dirName = `${ MCP_DIR_PREFIX }${ sanitizeSlug(accountId) }`;
  const dirPath = path.join(baseDir, dirName);

  // Ensure directory exists
  fs.mkdirSync(dirPath, { recursive: true });

  // Write auth config
  const authConfig = buildAuthYaml(accountId, accountLabel, serverUrl);
  const authFileName = `${ dirName }.v1-auth.yaml`;
  fs.writeFileSync(path.join(dirPath, authFileName), yaml.stringify(authConfig), 'utf-8');

  // Write one endpoint file per tool
  const toolNames: string[] = [];
  for (const tool of tools) {
    const epConfig = buildEndpointYaml(tool);
    const epFileName = `${ sanitizeSlug(tool.name) }.v1.yaml`;
    fs.writeFileSync(path.join(dirPath, epFileName), yaml.stringify(epConfig), 'utf-8');
    toolNames.push(tool.name);
  }

  // Remove stale endpoint files that no longer correspond to a tool
  cleanStaleEndpoints(dirPath, authFileName, toolNames);

  console.log(`${ LOG } Generated ${ tools.length } endpoint(s) for "${ accountId }" in ${ dirPath }`);

  return { dirName, dirPath, endpointCount: tools.length, toolNames };
}

/**
 * Remove a generated integration directory for an MCP account.
 */
export function removeConfigs(accountId: string, integrationsDir?: string): boolean {
  const baseDir = integrationsDir || resolveSullaIntegrationsDir();
  const dirName = `${ MCP_DIR_PREFIX }${ sanitizeSlug(accountId) }`;
  const dirPath = path.join(baseDir, dirName);

  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
    console.log(`${ LOG } Removed configs for "${ accountId }" at ${ dirPath }`);
    return true;
  }
  return false;
}

/**
 * Diff current tools against what's on disk to show added/removed/changed.
 */
export function diffConfigs(
  accountId: string,
  tools:     MCPToolDefinition[],
  integrationsDir?: string,
): DiffResult {
  const baseDir = integrationsDir || resolveSullaIntegrationsDir();
  const dirName = `${ MCP_DIR_PREFIX }${ sanitizeSlug(accountId) }`;
  const dirPath = path.join(baseDir, dirName);

  const onDisk = new Set<string>();
  if (fs.existsSync(dirPath)) {
    for (const f of fs.readdirSync(dirPath)) {
      if (f.endsWith('-auth.yaml')) continue;
      if (f.endsWith('.yaml') || f.endsWith('.yml')) {
        // Parse the file to get the endpoint name
        try {
          const raw = fs.readFileSync(path.join(dirPath, f), 'utf-8');
          const parsed = yaml.parse(raw);
          if (parsed?.endpoint?.name) {
            onDisk.add(parsed.endpoint.name);
          }
        } catch { /* skip unparseable files */ }
      }
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
      client_secret:           '${MCP_AUTH_TOKEN}',
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
 * Remove .v1.yaml files in the dir that don't correspond to current tools.
 */
function cleanStaleEndpoints(dirPath: string, authFileName: string, toolNames: string[]): void {
  const validFiles = new Set([
    authFileName,
    ...toolNames.map(n => `${ sanitizeSlug(n) }.v1.yaml`),
  ]);

  for (const f of fs.readdirSync(dirPath)) {
    if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
    if (!validFiles.has(f)) {
      fs.unlinkSync(path.join(dirPath, f));
      console.log(`${ LOG } Removed stale endpoint file: ${ f }`);
    }
  }
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
