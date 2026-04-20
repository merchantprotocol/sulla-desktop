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

import { randomBytes } from 'crypto';
import type { Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';

import express, { type NextFunction, type Request, type Response } from 'express';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { activateWorkflowOnState } from '@pkg/agent/tools/workflow/execute_workflow';

import type { BaseThreadState } from '@pkg/agent/nodes/Graph';

const LOG = '[MCPServerHost]';

// Hostname the Lima VM uses to reach the host it's running on. Lima adds
// this to the VM's /etc/hosts automatically.
const LIMA_HOST_DNS = 'host.lima.internal';

// Default session lifetime. Claude Code calls are short (usually <60s), but
// workflow orchestration can take longer — 10 min leaves room.
const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;

// Sweep frequency for expired sessions. Fast enough that crashes don't leak
// sessions for long, slow enough that it's negligible overhead.
const SESSION_SWEEP_INTERVAL_MS = 60 * 1000;

// ── Session registry types ─────────────────────────────────────

/**
 * A live Claude Code invocation bound to a specific graph instance. Tools
 * called over MCP during the invocation operate on `state` — they can
 * read/mutate the calling graph's metadata directly, which is the whole
 * point of the in-process bridge.
 */
interface Session {
  id:         string;
  state:      BaseThreadState;
  createdAt:  number;
  lastUsedAt: number;
  expiresAt:  number;
}

/** Returned from registerSession; the caller gives `url` to Claude Code and
 *  calls revoke when the invocation finishes. */
export interface RegisteredSession {
  id:     string;
  url:    string;
  /** Authorization header value Claude Code should include: `Bearer <id>`. */
  header: string;
  revoke: () => void;
}

let hostInstance: MCPServerHost | null = null;

export function getMCPServerHost(): MCPServerHost {
  if (!hostInstance) hostInstance = new MCPServerHost();
  return hostInstance;
}

export class MCPServerHost {
  private httpServer: HttpServer | null = null;
  private port = 0;
  private starting: Promise<void> | null = null;

  private readonly sessions = new Map<string, Session>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

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

  // ── Session registry ───────────────────────────────────────────

  /**
   * Bind a fresh session token to the calling graph's state. The returned
   * URL carries no secrets — the secret is the `header` value — so the URL
   * alone is safe to log. Pass the header to Claude Code in the MCP config
   * so every tool call carries proof of identity.
   *
   * Revoke as soon as the invocation finishes (finally block) to avoid
   * leaking references to a graph state that's no longer active.
   */
  registerSession(state: BaseThreadState, ttlMs: number = DEFAULT_SESSION_TTL_MS): RegisteredSession {
    if (!this.port) throw new Error(`${ LOG } cannot register session: server not started`);
    const id = randomBytes(24).toString('base64url');
    const now = Date.now();
    const session: Session = {
      id,
      state,
      createdAt:  now,
      lastUsedAt: now,
      expiresAt:  now + ttlMs,
    };
    this.sessions.set(id, session);
    return {
      id,
      url:    this.getVmReachableUrl(),
      header: `Bearer ${ id }`,
      revoke: () => this.revokeSession(id),
    };
  }

  revokeSession(id: string): void {
    this.sessions.delete(id);
  }

  private resolveSession(req: Request): Session | null {
    const auth = req.get('authorization') ?? req.get('Authorization');
    if (!auth) return null;
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (!match) return null;
    const id = match[1].trim();
    const session = this.sessions.get(id);
    if (!session) return null;
    const now = Date.now();
    if (session.expiresAt <= now) {
      this.sessions.delete(id);
      return null;
    }
    session.lastUsedAt = now;
    return session;
  }

  private sweepExpiredSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }

  async start(): Promise<void> {
    if (this.httpServer) return;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const app = express();
      app.use(express.json({ limit: '4mb' }));

      // Bearer-auth middleware for /mcp. The Bearer id maps to a registered
      // Sulla session, which in turn carries a reference to the calling
      // graph's live state. Unauthenticated calls are rejected before we
      // spin up any MCP machinery.
      const requireSession = (req: Request, res: Response, next: NextFunction): void => {
        const session = this.resolveSession(req);
        if (!session) {
          res.status(401).json({ error: 'invalid_or_expired_session' });
          return;
        }
        (req as any).sullaSession = session;
        next();
      };

      // Stateless StreamableHTTP — spin up a fresh server+transport per
      // request. This matches the pattern in the MCP SDK's own stateless
      // example and avoids having to correlate mcp-session-id headers
      // across requests when we don't need MCP's session feature.
      // Tool handlers close over the request's resolved session, so they
      // can reach straight into the calling graph's BaseThreadState.
      app.post('/mcp', requireSession, async (req: Request, res: Response) => {
        try {
          const session = (req as any).sullaSession as Session;
          const mcp = this.buildMcpServer(session);
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

      this.sweepTimer = setInterval(() => this.sweepExpiredSessions(), SESSION_SWEEP_INTERVAL_MS);
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
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.sessions.clear();
    if (!s) return;
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
    });
  }

  // ── Server construction ────────────────────────────────────────

  /**
   * Build a fresh McpServer with session-scoped tools. Called once per
   * inbound HTTP request — tool handlers close over the resolved session,
   * so they have direct access to the calling graph's BaseThreadState.
   *
   * Phase 2: ping + sulla_session_info (probe tool). Real native tools
   * like execute_workflow land in Phase 3 following the same pattern.
   */
  private buildMcpServer(session: Session): McpServer {
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

    // Probe tool for Phase 2 verification: echo back the session binding
    // so we can confirm the Authorization header resolved to the right
    // graph state before we ship real state-mutating tools. Does not
    // leak anything sensitive — only ids the user already controls.
    server.registerTool(
      'sulla_session_info',
      {
        description: 'Return metadata about the Sulla chat session that invoked you. Use this to confirm you are bound to the expected conversation before taking actions.',
      },
      async () => {
        const info = {
          conversationId: session.state.metadata.conversationId ?? null,
          threadId:       session.state.metadata.threadId ?? null,
          wsChannel:      session.state.metadata.wsChannel ?? null,
          hasActiveWorkflow: Boolean(session.state.metadata.activeWorkflow),
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }] };
      },
    );

    // execute_workflow — the whole reason this bridge exists. Delegates to
    // the same activateWorkflowOnState function that the in-process
    // BaseTool version calls, so semantics stay identical. The mutation
    // lands on session.state.metadata.activeWorkflow, which is the live
    // state of the graph that spawned this Claude Code invocation — the
    // orchestrator picks it up on the next cycle.
    server.registerTool(
      'execute_workflow',
      {
        description: [
          'Activate a Sulla workflow playbook on the current chat session.',
          'After this returns, the orchestrating agent takes over and drives the workflow to completion — do not send further assistant messages about the workflow; the playbook will emit its own updates.',
          'Pass the workflow slug (filename without extension) shown in your system prompt as workflowId. Optionally pass a message to use as the trigger input; if omitted, the last user message in the conversation is used.',
          'Set resume=true only when the user explicitly asks to continue a previously interrupted workflow run.',
        ].join(' '),
        inputSchema: {
          workflowId: z.string().describe('Workflow slug from the system prompt, e.g. "daily-planning".'),
          message:    z.string().optional().describe('Trigger message. Defaults to the last user message if omitted.'),
          resume:     z.boolean().optional().describe('Resume from the most recent checkpoint for this workflow instead of starting fresh.'),
        },
      },
      async ({ workflowId, message, resume }) => {
        const result = await activateWorkflowOnState(session.state, { workflowId, message, resume });
        return {
          content: [{ type: 'text' as const, text: result.responseString }],
          isError: !result.ok,
        };
      },
    );

    return server;
  }
}
