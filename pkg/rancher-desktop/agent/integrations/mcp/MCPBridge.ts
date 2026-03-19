/**
 * MCPBridge — singleton coordinating all connected MCP server accounts.
 *
 * Manages MCPClient instances per integration account, provides tool discovery
 * aggregated across all servers, and routes tool calls to the correct server.
 */

import { MCPClient } from './MCPClient';
import type { MCPToolDefinition, MCPToolCallResult } from './MCPClient';
import { getIntegrationService } from '../../services/IntegrationService';

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
