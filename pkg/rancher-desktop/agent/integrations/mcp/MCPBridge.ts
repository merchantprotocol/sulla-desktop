/**
 * MCPBridge — singleton coordinating all connected MCP server accounts.
 *
 * Manages MCPClient instances per integration account, provides tool discovery
 * aggregated across all servers, and routes tool calls to the correct server.
 */

import { MCPClient } from './MCPClient';
import type { MCPToolDefinition, MCPToolCallResult } from './MCPClient';
import { getIntegrationService } from '../../services/IntegrationService';
import {
  generateConfigs,
  removeConfigs,
  diffConfigs,
  type GenerateResult,
  type DiffResult,
} from './MCPConfigGenerator';

const LOG = '[MCPBridge]';
const INTEGRATION_ID = 'mcp';

export interface MCPEndpoint {
  name:        string;
  method:      string;
  path:        string;
  description: string;
  auth:        string;
  queryParams: { name: string; type: string; required: boolean; description: string }[];
  /** Account ID that owns this tool (for routing) */
  accountId:   string;
  /** Account label for display */
  accountLabel: string;
}

let instance: MCPBridge | null = null;

export class MCPBridge {
  private clients = new Map<string, MCPClient>();

  static getInstance(): MCPBridge {
    if (!instance) {
      instance = new MCPBridge();
    }
    return instance;
  }

  /**
   * Initialize all connected MCP accounts.
   * Called on startup and when accounts change.
   */
  async initializeAll(): Promise<void> {
    const svc = getIntegrationService();
    const accounts = await svc.getAccounts(INTEGRATION_ID);

    for (const account of accounts) {
      if (!account.connected) continue;

      if (this.clients.has(account.account_id)) {
        continue; // Already connected
      }

      try {
        await this.initializeAccount(account.account_id);
      } catch (err: any) {
        console.error(`${ LOG } Failed to initialize account ${ account.account_id }:`, err.message);
      }
    }

    console.log(`${ LOG } Initialized ${ this.clients.size } MCP server(s)`);
  }

  /**
   * Initialize a single account.
   */
  async initializeAccount(accountId: string): Promise<void> {
    const svc = getIntegrationService();

    const serverUrlVal = await svc.getIntegrationValue(INTEGRATION_ID, 'server_url', accountId);
    const authTokenVal = await svc.getIntegrationValue(INTEGRATION_ID, 'auth_token', accountId);

    const serverUrl = serverUrlVal?.value;
    if (!serverUrl) {
      console.warn(`${ LOG } Account ${ accountId } has no server_url, skipping`);
      return;
    }

    const authToken = authTokenVal?.value || undefined;

    const client = new MCPClient(serverUrl, accountId, authToken);
    await client.initialize();
    this.clients.set(accountId, client);

    console.log(`${ LOG } Account ${ accountId } connected (${ client.tools.length } tools)`);
  }

  /**
   * Refresh a single account (disconnect + reconnect).
   */
  async refreshAccount(accountId: string): Promise<void> {
    await this.removeAccount(accountId);
    await this.initializeAccount(accountId);
  }

  /**
   * Remove a single account.
   */
  async removeAccount(accountId: string): Promise<void> {
    const client = this.clients.get(accountId);
    if (client) {
      await client.close();
      this.clients.delete(accountId);
      console.log(`${ LOG } Removed account ${ accountId }`);
    }
  }

  /**
   * Check if any MCP server is connected.
   */
  get hasConnections(): boolean {
    return this.clients.size > 0;
  }

  /**
   * Get discovered tools for a specific account.
   */
  getToolsForAccount(accountId: string): MCPToolDefinition[] {
    return this.clients.get(accountId)?.tools || [];
  }

  /**
   * Get the server URL for a specific account.
   */
  getServerUrl(accountId: string): string | undefined {
    return this.clients.get(accountId)?.url;
  }

  /**
   * Get all MCP tools across all accounts, formatted as integration endpoints
   * for the /v1/integrations listing API.
   */
  getAllEndpoints(): MCPEndpoint[] {
    const endpoints: MCPEndpoint[] = [];

    for (const [accountId, client] of this.clients) {
      for (const tool of client.tools) {
        endpoints.push({
          name:         tool.name,
          method:       'POST',
          path:         '/tools/call',
          description:  tool.description,
          auth:         'required',
          accountId,
          accountLabel: accountId,
          queryParams:  this.inputSchemaToParams(tool.inputSchema),
        });
      }
    }

    return endpoints;
  }

  /**
   * Call a tool on a specific MCP server account.
   */
  async callTool(accountId: string, toolName: string, args: Record<string, any> = {}): Promise<MCPToolCallResult> {
    const client = this.clients.get(accountId);
    if (!client) {
      throw new Error(`${ LOG } No MCP client for account "${ accountId }". Connected accounts: ${ [...this.clients.keys()].join(', ') || 'none' }`);
    }
    return client.callTool(toolName, args);
  }

  // ── Config Generation (MCP → YAML) ────────────────────────────

  /**
   * Preview what tools an MCP server exposes without finalizing.
   * Connects temporarily if not already connected, discovers tools,
   * and returns a diff against any existing YAML configs on disk.
   */
  async discoverTools(accountId: string): Promise<{
    tools: MCPToolDefinition[];
    diff:  DiffResult;
  }> {
    // Initialize if not already connected
    if (!this.clients.has(accountId)) {
      await this.initializeAccount(accountId);
    }

    const tools = this.getToolsForAccount(accountId);
    const diff = diffConfigs(accountId, tools);

    return { tools, diff };
  }

  /**
   * Finalize: write YAML integration configs for an MCP account's tools.
   * After calling this, IntegrationConfigLoader.loadAll() will pick up
   * the generated mcp-{accountId}/ directory.
   */
  async finalizeConfigs(accountId: string): Promise<GenerateResult> {
    const client = this.clients.get(accountId);
    if (!client) {
      throw new Error(`${ LOG } Cannot finalize — account "${ accountId }" is not connected`);
    }

    const svc = getIntegrationService();
    const accounts = await svc.getAccounts(INTEGRATION_ID);
    const account = accounts.find(a => a.account_id === accountId);
    const label = account?.label || accountId;

    return generateConfigs(accountId, label, client.url, client.tools);
  }

  /**
   * Refresh YAML configs for an account: re-discover tools and regenerate.
   * Returns the diff of what changed.
   */
  async refreshConfigs(accountId: string): Promise<{
    result: GenerateResult;
    diff:   DiffResult;
  }> {
    // Re-discover tools from the live server
    const client = this.clients.get(accountId);
    if (!client) {
      throw new Error(`${ LOG } Cannot refresh — account "${ accountId }" is not connected`);
    }
    await client.discoverTools();

    const diff = diffConfigs(accountId, client.tools);
    const result = await this.finalizeConfigs(accountId);

    return { result, diff };
  }

  /**
   * Remove YAML configs for an MCP account.
   */
  removeConfigs(accountId: string): boolean {
    return removeConfigs(accountId);
  }

  /**
   * Generate YAML configs for all currently connected accounts.
   * Called on startup after initializeAll() to ensure configs exist.
   */
  async generateAllConfigs(): Promise<GenerateResult[]> {
    const results: GenerateResult[] = [];

    for (const [accountId, client] of this.clients) {
      try {
        const svc = getIntegrationService();
        const accounts = await svc.getAccounts(INTEGRATION_ID);
        const account = accounts.find(a => a.account_id === accountId);
        const label = account?.label || accountId;

        const result = generateConfigs(accountId, label, client.url, client.tools);
        results.push(result);
      } catch (err: any) {
        console.error(`${ LOG } Failed to generate configs for "${ accountId }":`, err.message);
      }
    }

    return results;
  }

  /**
   * Close all connections.
   */
  async closeAll(): Promise<void> {
    for (const [accountId, client] of this.clients) {
      try {
        await client.close();
      } catch (err) {
        console.error(`${ LOG } Error closing account ${ accountId }:`, err);
      }
    }
    this.clients.clear();
  }

  // ── Private ─────────────────────────────────────────────────

  /**
   * Convert MCP inputSchema to integration endpoint queryParams format.
   */
  private inputSchemaToParams(
    inputSchema: MCPToolDefinition['inputSchema'],
  ): MCPEndpoint['queryParams'] {
    const params: MCPEndpoint['queryParams'] = [];
    const required = new Set(inputSchema.required || []);

    for (const [name, schema] of Object.entries(inputSchema.properties || {})) {
      params.push({
        name,
        type:        (schema as any).type || 'string',
        required:    required.has(name),
        description: (schema as any).description || '',
      });
    }

    return params;
  }
}
