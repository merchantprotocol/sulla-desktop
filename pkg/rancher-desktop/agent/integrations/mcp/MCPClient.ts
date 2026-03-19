/**
 * MCPClient — wraps @modelcontextprotocol/sdk Client for a single MCP server.
 *
 * Handles transport selection (StreamableHTTP vs SSE), authentication,
 * tool discovery, and tool execution.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const LOG = '[MCPClient]';

export interface MCPToolDefinition {
  name:        string;
  description: string;
  inputSchema: {
    type:        'object';
    properties?: Record<string, any>;
    required?:   string[];
  };
}

export interface MCPToolCallResult {
  success: boolean;
  content: any[];
  isError: boolean;
  raw:     any;
}

export class MCPClient {
  private client: Client | null = null;
  private transport: Transport | null = null;
  private _tools: MCPToolDefinition[] = [];
  private _connected = false;

  constructor(
    private serverUrl: string,
    private accountId: string,
    private authToken?: string,
  ) {}

  get connected(): boolean {
    return this._connected;
  }

  get tools(): MCPToolDefinition[] {
    return this._tools;
  }

  /**
   * Connect to the MCP server and discover available tools.
   */
  async initialize(): Promise<void> {
    console.log(`${ LOG } Connecting to ${ this.serverUrl } (account: ${ this.accountId })`);

    this.client = new Client(
      { name: 'sulla-desktop', version: '1.0.0' },
      { capabilities: {} },
    );

    this.transport = this.createTransport();

    try {
      await this.client.connect(this.transport);
      this._connected = true;
      console.log(`${ LOG } Connected to ${ this.serverUrl }`);
    } catch (err: any) {
      // If StreamableHTTP failed and we haven't already tried SSE, fall back
      if (!this.serverUrl.includes('/sse') && this.transport instanceof StreamableHTTPClientTransport) {
        console.warn(`${ LOG } StreamableHTTP failed, retrying with SSE transport: ${ err.message }`);
        this.transport = this.createSSETransport();
        this.client = new Client(
          { name: 'sulla-desktop', version: '1.0.0' },
          { capabilities: {} },
        );
        await this.client.connect(this.transport);
        this._connected = true;
        console.log(`${ LOG } Connected via SSE fallback to ${ this.serverUrl }`);
      } else {
        throw err;
      }
    }

    await this.discoverTools();
  }

  /**
   * Discover available tools from the connected MCP server.
   */
  async discoverTools(): Promise<MCPToolDefinition[]> {
    if (!this.client) throw new Error(`${ LOG } Not connected`);

    const result = await this.client.listTools();
    this._tools = (result.tools || []).map(t => ({
      name:        t.name,
      description: t.description || '',
      inputSchema: {
        type:       'object',
        properties: (t.inputSchema as any)?.properties || {},
        required:   (t.inputSchema as any)?.required || [],
      },
    }));

    console.log(`${ LOG } Discovered ${ this._tools.length } tools from ${ this.serverUrl }: ${ this._tools.map(t => t.name).join(', ') }`);
    return this._tools;
  }

  /**
   * Call a tool on the MCP server.
   */
  async callTool(toolName: string, args: Record<string, any> = {}): Promise<MCPToolCallResult> {
    if (!this.client) throw new Error(`${ LOG } Not connected`);

    const result = await this.client.callTool({ name: toolName, arguments: args });

    // Normalize response — MCP returns { content: [...], isError?: boolean }
    // or { toolResult: unknown } for compatibility mode
    const content = 'content' in result ? (result as any).content : [];
    const isError = 'isError' in result ? !!(result as any).isError : false;

    return {
      success: !isError,
      content,
      isError,
      raw: result,
    };
  }

  /**
   * Ping the server to check health.
   */
  async ping(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close the connection.
   */
  async close(): Promise<void> {
    this._connected = false;
    if (this.client) {
      try {
        await this.client.close();
      } catch (err) {
        console.error(`${ LOG } Error closing client:`, err);
      }
      this.client = null;
    }
    if (this.transport) {
      try {
        await this.transport.close();
      } catch (err) {
        console.error(`${ LOG } Error closing transport:`, err);
      }
      this.transport = null;
    }
    this._tools = [];
    console.log(`${ LOG } Disconnected from ${ this.serverUrl }`);
  }

  // ── Private ─────────────────────────────────────────────────

  private createTransport(): Transport {
    if (this.serverUrl.includes('/sse')) {
      return this.createSSETransport();
    }
    return this.createStreamableHTTPTransport();
  }

  private createStreamableHTTPTransport(): StreamableHTTPClientTransport {
    const requestInit: RequestInit = {};
    if (this.authToken) {
      requestInit.headers = { Authorization: `Bearer ${ this.authToken }` };
    }
    return new StreamableHTTPClientTransport(
      new URL(this.serverUrl),
      {
        requestInit,
        reconnectionOptions: {
          maxReconnectionDelay:      30000,
          initialReconnectionDelay:  1000,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries:                3,
        },
      },
    );
  }

  private createSSETransport(): SSEClientTransport {
    const requestInit: RequestInit = {};
    if (this.authToken) {
      requestInit.headers = { Authorization: `Bearer ${ this.authToken }` };
    }
    return new SSEClientTransport(
      new URL(this.serverUrl),
      { requestInit },
    );
  }
}
