/**
 * MCPClient — wraps @modelcontextprotocol/sdk Client for a single MCP server.
 *
 * Handles transport selection (StreamableHTTP vs SSE), authentication,
 * tool discovery, and tool execution.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const LOG = '[MCPClient]';

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error) {
    return error;
  }
  try {
    return JSON.stringify(error) || 'Unknown error';
  } catch {
    return String(error) || 'Unknown error';
  }
}

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
  private client:    Client | null = null;
  private transport: Transport | null = null;
  private _tools:    MCPToolDefinition[] = [];
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

  get url(): string {
    return this.serverUrl;
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
    } catch (streamableError) {
      // If StreamableHTTP failed and we haven't already tried SSE, fall back
      if (!this.serverUrl.includes('/sse') && this.transport instanceof StreamableHTTPClientTransport) {
        const streamableMessage = errorMessage(streamableError);

        console.warn(`${ LOG } StreamableHTTP failed, retrying with SSE transport: ${ streamableMessage }`);
        await this.transport.close().catch(() => undefined);
        this.transport = this.createSSETransport();
        this.client = new Client(
          { name: 'sulla-desktop', version: '1.0.0' },
          { capabilities: {} },
        );
        try {
          await this.client.connect(this.transport);
          this._connected = true;
          console.log(`${ LOG } Connected via SSE fallback to ${ this.serverUrl }`);
        } catch (sseError) {
          throw new Error(
            `${ LOG } Could not connect to ${ this.serverUrl }. ` +
            `Streamable HTTP failed: ${ streamableMessage }. ` +
            `SSE fallback failed: ${ errorMessage(sseError) }`,
          );
        }
      } else {
        throw streamableError;
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
      raw:     result,
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

  private static LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', 'host.docker.internal'];

  /**
   * Check if the server URL points to a local address where we should
   * skip TLS certificate verification (self-signed certs are expected).
   */
  private isLocalUrl(): boolean {
    try {
      const hostname = new URL(this.serverUrl).hostname;
      return MCPClient.LOCAL_HOSTS.includes(hostname) ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.internal');
    } catch {
      return false;
    }
  }

  /**
   * Create a fetch function that skips TLS certificate verification.
   * Only used for local/internal MCP servers where self-signed certs are expected.
   */
  private createTlsPermissiveFetch(): (url: string | URL, init?: RequestInit) => Promise<Response> {
    const { Agent } = require('undici');
    const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    return (url: string | URL, init?: RequestInit): Promise<Response> => {
      return fetch(url, { ...init, dispatcher } as any);
    };
  }

  private createStreamableHTTPTransport(): StreamableHTTPClientTransport {
    const requestInit: RequestInit = {};
    if (this.authToken) {
      requestInit.headers = { Authorization: `Bearer ${ this.authToken }` };
    }
    const skipTls = this.serverUrl.startsWith('https:') && this.isLocalUrl();
    const fetchImpl = skipTls ? this.createTlsPermissiveFetch() : fetch;
    return new StreamableHTTPClientTransport(
      new URL(this.serverUrl),
      {
        requestInit,
        fetch: async(url, init) => {
          const response = await fetchImpl(url, init);

          // Streamable HTTP's optional GET stream may be unsupported by a
          // stateless server. Some small servers return their generic 404
          // instead of the specification's 405; normalize that response so
          // the SDK keeps using request/response POSTs rather than failing or
          // incorrectly falling back to the legacy SSE transport.
          if ((init?.method || 'GET').toUpperCase() === 'GET' && response.status === 404) {
            await response.body?.cancel();
            return new Response(null, {
              status:     405,
              statusText: 'Method Not Allowed',
            });
          }

          return response;
        },
        reconnectionOptions: {
          maxReconnectionDelay:        30000,
          initialReconnectionDelay:    1000,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries:                  3,
        },
      },
    );
  }

  private createSSETransport(): SSEClientTransport {
    const requestInit: RequestInit = {};
    if (this.authToken) {
      requestInit.headers = { Authorization: `Bearer ${ this.authToken }` };
    }
    const skipTls = this.serverUrl.startsWith('https:') && this.isLocalUrl();
    return new SSEClientTransport(
      new URL(this.serverUrl),
      {
        requestInit,
        ...(skipTls ? { fetch: this.createTlsPermissiveFetch() } : {}),
      },
    );
  }
}
