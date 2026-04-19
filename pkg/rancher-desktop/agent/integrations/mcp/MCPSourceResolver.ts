/**
 * MCPSourceResolver — resolves MCP server connections from various source formats.
 *
 * Accepts a URL, .mcp.json file, or docker-compose.yml and resolves it into
 * a connectable MCP server URL + credentials. Probes the server to verify
 * connectivity and discover tools.
 *
 * Pure business logic — no HTTP/Express dependencies.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import yaml from 'yaml';

import { MCPClient } from './MCPClient';

import type { MCPToolDefinition } from './MCPClient';

const LOG = '[MCPSourceResolver]';

// ── Types ─────────────────────────────────────────────────────────

/** What the caller provides */
export interface DiscoverSourceInput {
  url?:           string;
  file_path?:     string;
  auth_token?:    string;
  account_id?:    string;
  label?:         string;
  server_name?:   string;
  auto_register?: boolean;
}

/** Successful resolution result */
export interface DiscoverSourceResult {
  resolved_url:    string;
  transport:       'streamable-http' | 'sse';
  auth_token?:     string;
  suggested_id:    string;
  suggested_label: string;
  tools:           MCPToolDefinition[];
  tool_count:      number;
  source_type:     'url' | 'mcp-json' | 'docker-compose';
  source_details:  Record<string, any>;
}

/** Structured probe failure */
export interface ProbeFailure {
  url:        string;
  transport:  string;
  error:      string;
  suggestion: string;
}

/** Partial result returned alongside errors */
export interface PartialResult {
  resolved_url?:        string;
  source_type?:         string;
  missing_credentials?: string[];
  available_servers?:   string[];
}

// ── URL Probing ───────────────────────────────────────────────────

/**
 * Probe an MCP server at the given URL. Connects, lists tools, disconnects.
 * Returns tools + detected transport, or a ProbeFailure.
 */
export async function probeServer(
  url: string,
  authToken?: string,
): Promise<{ transport: 'streamable-http' | 'sse'; tools: MCPToolDefinition[] } | ProbeFailure> {
  const client = new MCPClient(url, '__probe__', authToken);
  try {
    await client.initialize();
    const tools = client.tools;

    // Detect which transport succeeded — if the URL contains /sse, it's SSE;
    // otherwise MCPClient tries StreamableHTTP first with SSE fallback.
    const transport: 'streamable-http' | 'sse' = url.includes('/sse') ? 'sse' : 'streamable-http';

    await client.close();
    return { transport, tools };
  } catch (err: any) {
    await client.close().catch(() => {});
    const msg = err.message || String(err);

    let suggestion = 'Check that the MCP server is running and the URL is correct.';
    if (msg.includes('401') || msg.includes('Unauthorized')) {
      suggestion = 'Authentication failed. Provide a valid auth_token (bearer token or application password).';
    } else if (msg.includes('ECONNREFUSED')) {
      suggestion = 'Connection refused. Is the MCP server running? Check the port and host.';
    } else if (msg.includes('ENOTFOUND')) {
      suggestion = 'Hostname not found. Check the URL — the host may be a Docker-internal name that is not reachable from this machine.';
    } else if (msg.includes('certificate')) {
      suggestion = 'TLS certificate error. For local servers, the system should auto-skip verification. Is the URL correct?';
    }

    return { url, transport: 'streamable-http', error: msg, suggestion };
  }
}

/**
 * Resolve from a raw URL: probe directly, return result.
 */
export async function resolveFromUrl(
  url: string,
  authToken?: string,
  accountId?: string,
  label?: string,
): Promise<DiscoverSourceResult | { probes: ProbeFailure[]; partial: PartialResult }> {
  const probeResult = await probeServer(url, authToken);

  if ('error' in probeResult) {
    return {
      probes:  [probeResult],
      partial: { resolved_url: url, source_type: 'url' },
    };
  }

  const suggestedId = accountId || slugFromUrl(url);
  return {
    resolved_url:    url,
    transport:       probeResult.transport,
    auth_token:      authToken,
    suggested_id:    suggestedId,
    suggested_label: label || labelFromSlug(suggestedId),
    tools:           probeResult.tools,
    tool_count:      probeResult.tools.length,
    source_type:     'url',
    source_details:  { url },
  };
}

// ── .mcp.json Parsing ─────────────────────────────────────────────

/**
 * Resolve from a .mcp.json file. Parses the JSON, extracts server entries,
 * resolves env vars, and attempts to find a reachable URL.
 */
export async function resolveFromMcpJson(
  filePath: string,
  serverName?: string,
  authTokenOverride?: string,
  accountId?: string,
  label?: string,
): Promise<DiscoverSourceResult | { probes: ProbeFailure[]; partial: PartialResult }> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const config = JSON.parse(raw);
  const servers: Record<string, any> = config.mcpServers || {};
  const serverNames = Object.keys(servers);

  if (serverNames.length === 0) {
    return {
      probes:  [{ url: filePath, transport: 'n/a', error: 'No mcpServers entries found in file', suggestion: 'Ensure the .mcp.json file has a "mcpServers" object with at least one entry.' }],
      partial: { source_type: 'mcp-json' },
    };
  }

  // Pick the target server
  const targetName = serverName || serverNames[0];
  const serverDef = servers[targetName];
  if (!serverDef) {
    return {
      probes:  [{ url: filePath, transport: 'n/a', error: `Server "${ targetName }" not found in .mcp.json`, suggestion: `Available servers: ${ serverNames.join(', ') }` }],
      partial: { source_type: 'mcp-json', available_servers: serverNames },
    };
  }

  const dir = path.dirname(filePath);
  const envMap = serverDef.env || {};
  const resolvedEnv = resolveEnvVars(envMap, dir);

  // Determine if this is a stdio server (command-based) or has a URL
  const command = serverDef.command;
  const args: string[] = serverDef.args || [];

  // Check if there's a direct URL in the env (some MCP configs store the server URL there)
  const serverUrl = serverDef.url || resolvedEnv.WORDPRESS_SITE_URL || resolvedEnv.MCP_SERVER_URL;

  if (command && !serverUrl) {
    // stdio-based server — try to find a running Docker container wrapping it
    const containerResult = await findDockerContainerForStdioServer(targetName, command, args, dir);
    if (containerResult) {
      const authToken = authTokenOverride || extractAuthFromEnv(resolvedEnv);
      const probeResult = await probeServer(containerResult.hostUrl, authToken);

      if ('error' in probeResult) {
        return {
          probes:  [probeResult],
          partial: {
            resolved_url:        containerResult.hostUrl,
            source_type:         'mcp-json',
            missing_credentials: findMissingCredentials(resolvedEnv),
          },
        };
      }

      const suggestedId = accountId || targetName;
      return {
        resolved_url:    containerResult.hostUrl,
        transport:       probeResult.transport,
        auth_token:      authToken,
        suggested_id:    suggestedId,
        suggested_label: label || labelFromSlug(suggestedId),
        tools:           probeResult.tools,
        tool_count:      probeResult.tools.length,
        source_type:     'mcp-json',
        source_details:  {
          file:       filePath,
          server:     targetName,
          command,
          container:  containerResult.containerName,
          host_url:   containerResult.hostUrl,
        },
      };
    }

    // No container found — report stdio-only
    return {
      probes: [{
        url:        filePath,
        transport:  'stdio',
        error:      `Server "${ targetName }" uses stdio transport (command: ${ command }) with no HTTP gateway found`,
        suggestion: 'This server runs via stdio. Either wrap it with supergateway in a Docker container, or run it directly via npx. No running Docker container was found exposing an HTTP endpoint for this server.',
      }],
      partial: { source_type: 'mcp-json', available_servers: serverNames },
    };
  }

  // URL-based — resolve and probe
  // The URL might be a Docker-internal hostname, so try both the raw URL and localhost variants
  const authToken = authTokenOverride || extractAuthFromEnv(resolvedEnv);
  const urlsToTry = buildUrlCandidates(serverUrl || '', dir);

  const probes: ProbeFailure[] = [];
  for (const candidateUrl of urlsToTry) {
    const probeResult = await probeServer(candidateUrl, authToken);
    if (!('error' in probeResult)) {
      const suggestedId = accountId || targetName;
      return {
        resolved_url:    candidateUrl,
        transport:       probeResult.transport,
        auth_token:      authToken,
        suggested_id:    suggestedId,
        suggested_label: label || labelFromSlug(suggestedId),
        tools:           probeResult.tools,
        tool_count:      probeResult.tools.length,
        source_type:     'mcp-json',
        source_details:  { file: filePath, server: targetName, original_url: serverUrl },
      };
    }
    probes.push(probeResult);
  }

  return {
    probes,
    partial: {
      resolved_url:        urlsToTry[0],
      source_type:         'mcp-json',
      missing_credentials: findMissingCredentials(resolvedEnv),
    },
  };
}

// ── Docker Compose Parsing ────────────────────────────────────────

/**
 * Resolve from a docker-compose.yml file. Finds MCP services,
 * resolves port mappings, and probes the host-accessible URL.
 */
export async function resolveFromDockerCompose(
  filePath: string,
  serviceName?: string,
  authTokenOverride?: string,
  accountId?: string,
  label?: string,
): Promise<DiscoverSourceResult | { probes: ProbeFailure[]; partial: PartialResult }> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const compose = yaml.parse(raw);
  const services: Record<string, any> = compose.services || {};

  // Find MCP-related services
  const mcpServices = findMCPServices(services);

  if (mcpServices.length === 0) {
    return {
      probes:  [{ url: filePath, transport: 'n/a', error: 'No MCP-related services found in docker-compose.yml', suggestion: 'Look for services with "mcp" in the name, command, or image. Available services: ' + Object.keys(services).join(', ') }],
      partial: { source_type: 'docker-compose' },
    };
  }

  // Pick the target service
  const target = serviceName
    ? mcpServices.find(s => s.name === serviceName) || mcpServices[0]
    : mcpServices[0];

  const svcDef = services[target.name];
  const dir = path.dirname(filePath);

  // Resolve environment variables
  const envMap = normalizeComposeEnv(svcDef.environment || {});
  const resolvedEnv = resolveEnvVars(envMap, dir);

  // Resolve port mappings
  const ports = parseComposePorts(svcDef.ports || []);
  const containerName = svcDef.container_name || null;

  // If we have a container name, also try live docker port resolution
  let livePortMap: Map<number, number> | null = null;
  if (containerName) {
    livePortMap = resolveDockerPorts(containerName);
  }

  // Figure out the internal MCP port and path
  const { internalPort, mcpPath } = detectMCPEndpoint(svcDef);

  // Build the host-accessible URL
  const hostPort = resolveHostPort(internalPort, ports, livePortMap);
  if (!hostPort) {
    return {
      probes: [{
        url:        filePath,
        transport:  'n/a',
        error:      `Could not resolve host port for internal port ${ internalPort } of service "${ target.name }"`,
        suggestion: `The service exposes port ${ internalPort } internally but no host port mapping was found. Check the "ports:" section in docker-compose.yml or run "docker port ${ containerName || target.name }".`,
      }],
      partial: { source_type: 'docker-compose' },
    };
  }

  const resolvedUrl = `http://localhost:${ hostPort }${ mcpPath }`;
  const authToken = authTokenOverride || extractAuthFromEnv(resolvedEnv);

  // Probe the resolved URL
  const probeResult = await probeServer(resolvedUrl, authToken);

  if ('error' in probeResult) {
    return {
      probes:  [probeResult],
      partial: {
        resolved_url:        resolvedUrl,
        source_type:         'docker-compose',
        missing_credentials: findMissingCredentials(resolvedEnv),
      },
    };
  }

  const suggestedId = accountId || sanitizeSlug(target.name.replace(/^.*mcp-?/i, '') || target.name);
  return {
    resolved_url:    resolvedUrl,
    transport:       probeResult.transport,
    auth_token:      authToken,
    suggested_id:    suggestedId || 'mcp-server',
    suggested_label: label || labelFromSlug(suggestedId || target.name),
    tools:           probeResult.tools,
    tool_count:      probeResult.tools.length,
    source_type:     'docker-compose',
    source_details:  {
      file:          filePath,
      service:       target.name,
      container:     containerName,
      internal_port: internalPort,
      host_port:     hostPort,
      mcp_path:      mcpPath,
    },
  };
}

// ── Top-Level Resolver ────────────────────────────────────────────

/**
 * Main entry point. Dispatches to the correct resolver based on input.
 */
export async function resolve(
  input: DiscoverSourceInput,
): Promise<DiscoverSourceResult | { probes: ProbeFailure[]; partial: PartialResult }> {
  if (input.url) {
    return resolveFromUrl(input.url, input.auth_token, input.account_id, input.label);
  }

  if (input.file_path) {
    const filePath = input.file_path;

    if (!fs.existsSync(filePath)) {
      return {
        probes:  [{ url: filePath, transport: 'n/a', error: `File not found: ${ filePath }`, suggestion: 'Check the file path.' }],
        partial: {},
      };
    }

    const basename = path.basename(filePath).toLowerCase();

    if (basename === '.mcp.json' || basename.endsWith('.mcp.json')) {
      return resolveFromMcpJson(filePath, input.server_name, input.auth_token, input.account_id, input.label);
    }

    if (basename.includes('docker-compose') || basename.includes('compose.y')) {
      return resolveFromDockerCompose(filePath, input.server_name, input.auth_token, input.account_id, input.label);
    }

    // Try to detect file type by content
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (content.startsWith('{') && content.includes('mcpServers')) {
      return resolveFromMcpJson(filePath, input.server_name, input.auth_token, input.account_id, input.label);
    }
    if (content.includes('services:')) {
      return resolveFromDockerCompose(filePath, input.server_name, input.auth_token, input.account_id, input.label);
    }

    return {
      probes:  [{ url: filePath, transport: 'n/a', error: 'Unrecognized file format', suggestion: 'Provide a .mcp.json file or a docker-compose.yml file.' }],
      partial: { source_type: 'unknown' },
    };
  }

  return {
    probes:  [{ url: '', transport: 'n/a', error: 'No source provided', suggestion: 'Provide either a "url" or "file_path" field.' }],
    partial: {},
  };
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Resolve environment variable references. Checks .env file in the
 * given directory, then process.env, then leaves empty values as-is.
 */
export function resolveEnvVars(
  envMap: Record<string, string>,
  sourceDir: string,
): Record<string, string> {
  // Load .env file if present
  const dotEnv: Record<string, string> = {};
  const envFile = path.join(sourceDir, '.env');
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        dotEnv[key] = val;
      }
    }
  }

  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(envMap)) {
    if (!value || value === '') {
      // Check .env then process.env
      resolved[key] = dotEnv[key] || process.env[key] || '';
    } else if (value.startsWith('${') && value.endsWith('}')) {
      const envName = value.slice(2, -1);
      resolved[key] = dotEnv[envName] || process.env[envName] || '';
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}

/**
 * Resolve Docker port mappings by running `docker port <container>`.
 */
export function resolveDockerPorts(containerName: string): Map<number, number> | null {
  try {
    const output = execSync(`docker port ${ containerName }`, { encoding: 'utf-8', timeout: 5000 });
    const portMap = new Map<number, number>();

    for (const line of output.split('\n')) {
      // Format: "7391/tcp -> 0.0.0.0:3001"
      const match = /^(\d+)\/\w+\s+->\s+[\d.]+:(\d+)/.exec(line);
      if (match) {
        portMap.set(parseInt(match[1], 10), parseInt(match[2], 10));
      }
    }

    return portMap.size > 0 ? portMap : null;
  } catch {
    return null;
  }
}

/**
 * Parse docker-compose port mappings from the ports array.
 * Supports "HOST:CONTAINER" and "HOST:CONTAINER/protocol" formats.
 */
function parseComposePorts(ports: (string | number | Record<string, any>)[]): Map<number, number> {
  const portMap = new Map<number, number>();

  for (const entry of ports) {
    if (typeof entry === 'string') {
      // "3001:7391" or "3001:7391/tcp"
      const match = /^"?(\d+):(\d+)/.exec(entry);
      if (match) {
        portMap.set(parseInt(match[2], 10), parseInt(match[1], 10));
      }
    } else if (typeof entry === 'object' && entry !== null) {
      // Long syntax: { target: 7391, published: 3001 }
      if (entry.target && entry.published) {
        portMap.set(Number(entry.target), Number(entry.published));
      }
    }
  }

  return portMap;
}

/**
 * Normalize docker-compose environment block.
 * Handles both array format ["KEY=value"] and object format { KEY: value }.
 */
function normalizeComposeEnv(env: any): Record<string, string> {
  if (Array.isArray(env)) {
    const result: Record<string, string> = {};
    for (const entry of env) {
      const eqIdx = String(entry).indexOf('=');
      if (eqIdx > 0) {
        result[String(entry).slice(0, eqIdx)] = String(entry).slice(eqIdx + 1);
      }
    }
    return result;
  }
  if (typeof env === 'object' && env !== null) {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      result[k] = String(v ?? '');
    }
    return result;
  }
  return {};
}

/**
 * Find MCP-related services in a docker-compose services block.
 */
function findMCPServices(services: Record<string, any>): { name: string; score: number }[] {
  const results: { name: string; score: number }[] = [];

  for (const [name, def] of Object.entries(services)) {
    let score = 0;
    const haystack = [
      name,
      def.image || '',
      typeof def.command === 'string' ? def.command : Array.isArray(def.command) ? def.command.join(' ') : '',
      def.container_name || '',
    ].join(' ').toLowerCase();

    if (haystack.includes('mcp')) score += 10;
    if (haystack.includes('supergateway')) score += 5;
    if (haystack.includes('model-context-protocol') || haystack.includes('modelcontextprotocol')) score += 5;

    if (score > 0) {
      results.push({ name, score });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Detect the MCP endpoint (internal port + path) from a service definition.
 */
function detectMCPEndpoint(svcDef: Record<string, any>): { internalPort: number; mcpPath: string } {
  const command = typeof svcDef.command === 'string'
    ? svcDef.command
    : Array.isArray(svcDef.command) ? svcDef.command.join(' ') : '';

  // Check for --port flag in supergateway command
  const portMatch = /--port\s+(\d+)/.exec(command);
  const internalPort = portMatch ? parseInt(portMatch[1], 10) : 7391;

  // Check for --streamableHttpPath
  const pathMatch = /--streamableHttpPath\s+(\S+)/.exec(command);
  const mcpPath = pathMatch ? pathMatch[1] : '/mcp';

  return { internalPort, mcpPath };
}

/**
 * Resolve the host port for a given internal container port.
 */
function resolveHostPort(
  internalPort: number,
  composePorts: Map<number, number>,
  livePortMap: Map<number, number> | null,
): number | null {
  // Prefer live docker port resolution (most accurate)
  if (livePortMap?.has(internalPort)) {
    return livePortMap.get(internalPort)!;
  }
  // Fall back to compose file port mapping
  if (composePorts.has(internalPort)) {
    return composePorts.get(internalPort)!;
  }
  return null;
}

/**
 * Try to find a running Docker container for a stdio-based MCP server.
 * Looks for containers whose command matches the server definition.
 */
async function findDockerContainerForStdioServer(
  serverName: string,
  command: string,
  args: string[],
  sourceDir: string,
): Promise<{ containerName: string; hostUrl: string } | null> {
  try {
    // Look for containers with 'mcp' in the name matching this server
    const output = execSync(
      `docker ps --format '{{.Names}}\\t{{.Ports}}' 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 },
    );

    const packageName = args.find(a => a.startsWith('mcp-') || a.includes('mcp')) || '';

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      const [containerName, ports] = line.split('\t');
      if (!containerName) continue;

      // Match by server name or MCP package name
      const nameLower = containerName.toLowerCase();
      const nameMatches = nameLower.includes(serverName.toLowerCase()) ||
        (packageName && nameLower.includes(sanitizeSlug(packageName)));

      if (!nameMatches) continue;

      // Extract host port from the ports column (e.g. "0.0.0.0:3001->7391/tcp")
      const portMatch = /[\d.]+:(\d+)->(\d+)/.exec((ports || ''));
      if (portMatch) {
        const hostPort = parseInt(portMatch[1], 10);
        // Try to find the MCP path by inspecting the container command
        const hostUrl = `http://localhost:${ hostPort }/mcp`;
        return { containerName, hostUrl };
      }
    }

    // Also try docker-compose in the source directory
    const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
    for (const cf of composeFiles) {
      const composePath = path.join(sourceDir, cf);
      if (fs.existsSync(composePath)) {
        const compose = yaml.parse(fs.readFileSync(composePath, 'utf-8'));
        const services = compose.services || {};
        for (const [svcName, svcDefRaw] of Object.entries(services)) {
          const svcDef = svcDefRaw as Record<string, any>;
          const svcCommand = typeof svcDef.command === 'string' ? svcDef.command : '';
          if (svcCommand.includes(packageName) || svcName.includes('mcp')) {
            const containerNameFromCompose = svcDef.container_name || svcName;
            const livePortMap = resolveDockerPorts(containerNameFromCompose);
            if (livePortMap) {
              const { internalPort, mcpPath } = detectMCPEndpoint(svcDef);
              const hostPort = livePortMap.get(internalPort);
              if (hostPort) {
                return {
                  containerName: containerNameFromCompose,
                  hostUrl:       `http://localhost:${ hostPort }${ mcpPath }`,
                };
              }
            }
          }
        }
      }
    }
  } catch {
    // Docker not available or command failed — that's fine
  }

  return null;
}

/**
 * Extract an auth token from resolved environment variables.
 * Looks for common credential patterns.
 */
function extractAuthFromEnv(env: Record<string, string>): string | undefined {
  const candidates = [
    'MCP_AUTH_TOKEN',
    'AUTH_TOKEN',
    'BEARER_TOKEN',
    'API_KEY',
    'MCP_API_KEY',
  ];

  for (const key of candidates) {
    if (env[key]) return env[key];
  }

  return undefined;
}

/**
 * Find credential env vars that are empty (likely need user input).
 */
function findMissingCredentials(env: Record<string, string>): string[] {
  const credentialPatterns = /password|secret|token|key|auth/i;
  const missing: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    if (credentialPatterns.test(key) && !value) {
      missing.push(key);
    }
  }

  return missing;
}

/**
 * Build URL candidates to try when the original URL might be Docker-internal.
 */
function buildUrlCandidates(originalUrl: string, sourceDir: string): string[] {
  if (!originalUrl) return [];

  const candidates = [originalUrl];

  try {
    const parsed = new URL(originalUrl);
    const hostname = parsed.hostname;

    // If the hostname looks Docker-internal, add localhost variants
    const dockerInternal = !['localhost', '127.0.0.1', '::1'].includes(hostname) &&
      !hostname.includes('.');

    if (dockerInternal) {
      // Try localhost with the same port
      const localhostUrl = new URL(originalUrl);
      localhostUrl.hostname = 'localhost';
      candidates.push(localhostUrl.toString().replace(/\/$/, ''));

      // Also try common MCP paths if not already present
      if (!parsed.pathname || parsed.pathname === '/') {
        candidates.push(`${ localhostUrl.origin }/mcp`);
        candidates.push(`${ localhostUrl.origin }/sse`);
      }
    }
  } catch {
    // Invalid URL — just return original
  }

  return candidates;
}

function slugFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    const port = new URL(url).port;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return port ? `mcp-${ port }` : 'mcp-local';
    }
    return sanitizeSlug(hostname.split('.')[0]);
  } catch {
    return 'mcp-server';
  }
}

function labelFromSlug(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
