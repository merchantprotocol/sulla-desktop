/**
 * MCPServerHost — in-process MCP server that Claude Code (running inside the
 * Lima VM) can call back into during a chat turn.
 *
 * Why this exists:
 *   Claude Code's CLI runs inside the Lima VM and has no direct access to the
 *   live BaseThreadState of the graph that invoked it. Native functions like
 *   `execute_workflow` need to mutate `state.metadata.activeWorkflow` on the
 *   CALLING graph instance so the orchestrator's next cycle can take over.
 *
 *   Exposing those functions as MCP tools lets Claude call them mid-turn.
 *   Because this server runs inside the same Electron process as the graph,
 *   tool handlers can resolve the calling graph via a session token and
 *   mutate its metadata directly — no IPC, no serialization round-trip.
 *
 * Lifecycle:
 *   - Started once at app boot (main-process singleton).
 *   - Binds to 0.0.0.0 on a random high port; Lima's portForwards rule
 *     (hostIP 0.0.0.0, guestPortRange 1–65535) plus the VM's built-in
 *     `host.lima.internal` DNS entry means the VM can reach it at
 *     `http://host.lima.internal:<port>/mcp`.
 *   - Transport is stateless StreamableHTTP — one transport per request. We
 *     do NOT use MCP's own session mechanism; session-binding for tools (so
 *     a handler knows which graph it's running for) is layered on top via an
 *     Authorization: Bearer <sullaSessionId> header, added in Phase 2.
 *
 * Phase 1 (this file): only a `ping` tool is registered, which returns
 * `pong`. That's enough to verify the transport, CLI discovery, and the
 * Lima ↔ host network path before we wire in session binding.
 */

import type { Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';

import express, { type Request, type Response } from 'express';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const LOG = '[MCPServerHost]';

// Hostname the Lima VM uses to reach the host it's running on. Lima adds
// this to the VM's /etc/hosts automatically.
const LIMA_HOST_DNS = 'host.lima.internal';

let hostInstance: MCPServerHost | null = null;

export function getMCPServerHost(): MCPServerHost {
  if (!hostInstance) hostInstance = new MCPServerHost();
  return hostInstance;
}

export class MCPServerHost {
  private httpServer: HttpServer | null = null;
  private port = 0;
  private starting: Promise<void> | null = null;

  get running(): boolean {
    return this.httpServer !== null;
  }

  get listeningPort(): number {
    return this.port;
  }

  /**
   * URL Claude Code (inside the Lima VM) should use to reach this server.
   */
  getVmReachableUrl(): string {
    if (!this.port) throw new Error(`${ LOG } not started`);
    return `http://${ LIMA_HOST_DNS }:${ this.port }/mcp`;
  }

  async start(): Promise<void> {
    if (this.httpServer) return;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const app = express();
      app.use(express.json({ limit: '4mb' }));

      // Stateless StreamableHTTP — spin up a fresh server+transport per
      // request. This matches the pattern in the MCP SDK's own stateless
      // example and avoids having to correlate mcp-session-id headers
      // across requests when we don't need MCP's session feature.
      app.post('/mcp', async (req: Request, res: Response) => {
        try {
          const mcp = this.buildMcpServer();
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          res.on('close', () => {
            try { transport.close(); } catch { /* ignore */ }
            try { mcp.close(); } catch { /* ignore */ }
          });
          await mcp.connect(transport);
          await transport.handleRequest(req as any, res as any, req.body);
        } catch (err) {
          console.error(`${ LOG } request handler error:`, err);
          if (!res.headersSent) res.status(500).json({ error: 'mcp_server_error' });
        }
      });

      // GET and DELETE are used for the stateful session dance. We're
      // stateless, so reject them cleanly so curl-probes get a meaningful
      // response instead of a hang.
      app.get('/mcp', (_req, res) => res.status(405).json({ error: 'method_not_allowed' }));
      app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'method_not_allowed' }));

      // Simple liveness check — unrelated to MCP protocol; useful for
      // diagnostics and smoke tests from the VM.
      app.get('/healthz', (_req, res) => res.json({ ok: true, port: this.port }));

      await new Promise<void>((resolve, reject) => {
        const server = app.listen(0, '0.0.0.0', () => {
          const addr = server.address() as AddressInfo | null;
          this.port = addr?.port ?? 0;
          this.httpServer = server;
          console.log(`${ LOG } listening on 0.0.0.0:${ this.port } — VM url ${ this.getVmReachableUrl() }`);
          resolve();
        });
        server.once('error', reject);
      });
    })();

    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async stop(): Promise<void> {
    const s = this.httpServer;
    this.httpServer = null;
    this.port = 0;
    if (!s) return;
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
    });
  }

  // ── Server construction ────────────────────────────────────────

  /**
   * Build a fresh McpServer with all tools registered. Called once per
   * inbound HTTP request in stateless mode.
   *
   * Phase 1: only `ping` is registered. Phase 2 adds session-scoped tools
   * (execute_workflow etc.) that read an Authorization: Bearer <sessionId>
   * header via the transport's `extra` argument.
   */
  private buildMcpServer(): McpServer {
    const server = new McpServer(
      { name: 'sulla-native', version: '1.0.0' },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    server.registerTool(
      'ping',
      {
        description: 'Verify connectivity to the Sulla native MCP server. Returns "pong" on success.',
      },
      async () => ({
        content: [{ type: 'text' as const, text: 'pong' }],
      }),
    );

    return server;
  }
}
