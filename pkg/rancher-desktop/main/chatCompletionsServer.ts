import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { GraphRegistry, nextThreadId, nextMessageId } from '@pkg/agent/services/GraphRegistry';
import { getWebSocketClientService, type WebSocketMessage } from '@pkg/agent/services/WebSocketClientService';
import { resolveSullaAgentsDir } from '@pkg/agent/utils/sullaPaths';

const CHAT_COMPLETIONS_PORT = parseInt('3000', 10);
const WS_CHANNEL = 'tasker';

export class ChatCompletionsServer {
  private app = express();
  private server:            any = null;
  private readonly wsService = getWebSocketClientService();
  private taskerUnsubscribe: (() => void) | null = null;

  constructor() {
    this.initializeTaskerWebSocketListener();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private initializeTaskerWebSocketListener(): void {
    this.wsService.connect(WS_CHANNEL);
    this.taskerUnsubscribe = this.wsService.onMessage(WS_CHANNEL, (msg: WebSocketMessage) => {
      void this.handleTaskerInboundMessage(msg);
    });
  }

  private async handleTaskerInboundMessage(msg: WebSocketMessage): Promise<void> {
    this.logTaskerInboundMessage(msg);

    if (msg.type !== 'user_message') {
      return;
    }

    const payload = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
    const content = typeof payload?.content === 'string' ? payload.content.trim() : '';
    const metadata = payload?.metadata;

    if (!content) {
      return;
    }

    try {
      const responseText = await this.processUserInputDirect([
        {
          id:        nextMessageId(),
          role:      'user',
          content,
          timestamp: Date.now(),
          metadata:  { source: 'tasker', origin: metadata?.origin || 'unknown' },
        },
      ]);

      if (!responseText.trim()) {
        return;
      }

      await this.wsService.send(WS_CHANNEL, {
        type: 'assistant_message',
        data: {
          role:     'assistant',
          content:  responseText,
          metadata: {
            origin:           'tasker_router',
            replyToId:        msg.id,
            requestOrigin:    metadata?.origin,
            requestEventType: metadata?.eventType,
            slackChannel:     metadata?.channel,
            slackThreadTs:    metadata?.threadTs,
            slackUser:        metadata?.user,
          },
        },
        channel: WS_CHANNEL,
      });
    } catch (error) {
      console.error('[ChatCompletionsAPI] Failed to process tasker user_message:', error);
    }
  }

  private logTaskerInboundMessage(msg: WebSocketMessage): void {
    const payload = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
    const content = typeof payload?.content === 'string' ? payload.content.trim() : '';
    const metadata = payload?.metadata;

    console.log('[ChatCompletionsAPI] ← tasker message', {
      type:         msg.type,
      id:           msg.id,
      channel:      msg.channel,
      timestamp:    msg.timestamp,
      metadata,
      contentChars: content.length,
      content:      content.slice(0, 100),
    });

    if (msg.type === 'user_message' && metadata?.origin === 'slack' && metadata?.eventType === 'app_mention') {
      console.log('[ChatCompletionsAPI] Tasker listener received Slack app_mention trigger', {
        id:            msg.id,
        slackChannel:  metadata?.channel,
        slackThreadTs: metadata?.threadTs,
        slackUser:     metadata?.user,
      });
    }
  }

  /**
   * Setup the middleware for the chat completions server.
   */
  private setupMiddleware() {
    // Enable CORS for all origins (since this is a public API)
    this.app.use(cors({
      origin:      true, // Allow all origins
      credentials: true,
    }));

    // Parse JSON bodies
    this.app.use(express.json({ limit: '10mb' }));

    // Add request logging
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      console.log(`[ChatCompletionsAPI] ${ req.method } ${ req.path }`);
      next();
    });
  }

  /**
   * Setup the routes for the chat completions server.
   */
  private setupRoutes() {
    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // OpenAI-compatible models endpoint
    this.app.get('/v1/models', async(req: Request, res: Response) => {
      await this.handleModels(req, res);
    });

    // OpenAI-compatible chat completions endpoint
    this.app.post('/v1/chat/completions', async(req: Request, res: Response) => {
      await this.handleChatCompletions(req, res);
    });

    // OpenAI-compatible completions endpoint
    this.app.post('/v1/completions', async(req: Request, res: Response) => {
      await this.handleCompletions(req, res);
    });

    // OpenAI-compatible embeddings endpoint
    this.app.post('/v1/embeddings', async(req: Request, res: Response) => {
      await this.handleEmbeddings(req, res);
    });

    // OpenAI-compatible moderations endpoint
    this.app.post('/v1/moderations', async(req: Request, res: Response) => {
      await this.handleModerations(req, res);
    });

    // ── Tools API endpoints ──────────────────────────────────────────

    // List all tools (integrations + MCP)
    this.app.get('/v1/tools/list', async(req: Request, res: Response) => {
      await this.handleListIntegrations(req, res);
    });

    // Call a tool endpoint with specific account credentials
    this.app.post('/v1/tools/:accountId/:slug/:endpoint/call', async(req: Request, res: Response) => {
      await this.handleIntegrationCall(req, res);
    });

    // ── MCP Config Generation endpoints ─────────────────────────────
    // Register: save MCP server credentials (server_url + optional auth_token)
    this.app.post('/v1/mcp/register', async(req: Request, res: Response) => {
      await this.handleMCPRegister(req, res);
    });

    // Discover: connect to an MCP account, list tools, diff against existing configs
    this.app.post('/v1/mcp/:accountId/discover', async(req: Request, res: Response) => {
      await this.handleMCPDiscover(req, res);
    });

    // Finalize: write YAML configs from discovered tools, then reload the config loader
    this.app.post('/v1/mcp/:accountId/finalize', async(req: Request, res: Response) => {
      await this.handleMCPFinalize(req, res);
    });

    // Refresh: re-discover tools and regenerate configs
    this.app.post('/v1/mcp/:accountId/refresh', async(req: Request, res: Response) => {
      await this.handleMCPRefresh(req, res);
    });

    // Discover source: resolve MCP server from URL, .mcp.json, or docker-compose.yml
    this.app.post('/v1/mcp/discover-source', async(req: Request, res: Response) => {
      await this.handleMCPDiscoverSource(req, res);
    });

    // Remove: delete generated YAML configs for an MCP account
    this.app.delete('/v1/mcp/:accountId/configs', async(req: Request, res: Response) => {
      await this.handleMCPRemoveConfigs(req, res);
    });

    // Backward compatibility aliases
    this.app.get('/v1/integrations', async(req: Request, res: Response) => {
      await this.handleListIntegrations(req, res);
    });
    this.app.post('/v1/integrations/:accountId/:slug/:endpoint/call', async(req: Request, res: Response) => {
      await this.handleIntegrationCall(req, res);
    });

    // Catch-all for unknown routes
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({
        error: {
          message: `Endpoint ${ req.method } ${ req.path } not found`,
          type:    'invalid_request_error',
        },
      });
    });
  }

  /**
   * Handle chat completions requests.
   */
  public async handleChatCompletions(req: Request, res: Response) {
    try {
      const { messages, model = 'sulla', temperature = 0.7, max_tokens, stream = false, thread_id } = req.body;

      // Log each incoming message with truncated content
      if (Array.isArray(messages)) {
        for (const m of messages) {
          const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
          console.log('[ChatCompletionsAPI] ← chat message', {
            role:         m.role,
            name:         m.name,
            model,
            thread_id,
            temperature,
            stream,
            contentChars: raw.length,
            content:      raw.slice(0, 100),
          });
        }
      }

      // Validate request
      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({
          error: {
            message: 'messages array is required',
            type:    'invalid_request_error',
          },
        });
      }

      // Get the last message
      const lastMessage = messages[messages.length - 1];

      // For streaming responses, we'd need to implement SSE
      if (stream) {
        return res.status(400).json({
          error: {
            message: 'Streaming is not yet implemented',
            type:    'not_implemented',
          },
        });
      }

      // Extract the user message content
      const userText = typeof lastMessage.content === 'string'
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);

      console.log(`[ChatCompletionsAPI] Processing message: ${ userText.substring(0, 100) }...`);

      // Process the user input directly — model param is the agent ID
      const resolvedThreadId = thread_id || nextThreadId();
      const responseContent = await this.processUserInputDirect(messages, model, resolvedThreadId);

      // Return the response in OpenAI format
      const response = {
        id:        `chatcmpl-${ Date.now() }`,
        object:    'chat.completion',
        created:   Math.floor(Date.now() / 1000),
        model,
        thread_id: resolvedThreadId,
        choices:   [{
          index:   0,
          message: {
            role:    'assistant',
            content: responseContent,
          },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens:     Math.ceil(userText.length / 4), // Rough estimate
          completion_tokens: Math.ceil(responseContent.length / 4), // Rough estimate
          total_tokens:      Math.ceil(userText.length / 4) + Math.ceil(responseContent.length / 4),
        },
      };

      console.log(`[ChatCompletionsAPI] Response sent (thread=${ resolvedThreadId })`);

      res.json(response);
    } catch (error) {
      console.error('[ChatCompletionsAPI] Error handling chat completion:', error);
      res.status(500).json({
        error: {
          message: 'Internal server error',
          type:    'internal_error',
        },
      });
    }
  }

  /**
   * Process user input directly, without any UI interaction.
   * The agentId is used as the wsChannel so the graph loads that agent's prompts.
   */
  private async processUserInputDirect(messages: any, agentId: string = WS_CHANNEL, threadId?: string): Promise<string> {
    threadId = threadId || nextThreadId();

    // Get or create persistent AgentGraph for this thread
    const { graph, state } = await GraphRegistry.getOrCreateAgentGraph(agentId, threadId, {
      userVisibleBrowser: false,
      isTrustedUser:      'untrusted',
    });

    try {
      state.metadata.wsChannel = agentId;

      // Append new user messages
      for (const msg of messages) {
        state.messages.push({
          id:        msg.id || nextMessageId(),
          role:      msg.role || 'user',
          content:   msg.content,
          timestamp: msg.timestamp || Date.now(),
          metadata:  msg.metadata || { source: 'api' },
        });
      }

      // Reset pause flags when real user input comes in
      state.metadata.cycleComplete = false;
      state.metadata.waitingForUser = false;

      // Execute on the persistent AgentGraph starting from input_handler
      await graph.execute(state, 'input_handler');

      // Extract the final response text
      const agentMeta = (state.metadata as any).agent;
      const responseText =
        agentMeta?.response?.trim() ||
        agentMeta?.status_report?.trim() ||
        state.metadata.finalSummary?.trim() ||
        (() => {
          const msg = [...state.messages].reverse().find((m: any) => m.role === 'assistant');
          if (!msg?.content) return '';
          return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        })() ||
        '';

      return responseText;
    } catch (err: any) {
      console.error('[ChatCompletionsAPI] Error processing user input:', err);
      return `Error: ${ err.message || String(err) }`;
    } finally {
      // Park the graph so it won't re-enter on its own
      state.metadata.waitingForUser = true;
      state.metadata.cycleComplete = true;
      state.metadata.consecutiveSameNode = 0;
      state.metadata.iterations = 0;
    }
  }

  /**
   * Handle models requests (OpenAI-compatible).
   * Returns available agent IDs read from ~/sulla/agents/.
   */
  public async handleModels(req: Request, res: Response) {
    try {
      const agentsDir = resolveSullaAgentsDir();
      let agentIds: string[] = [];

      try {
        const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
        agentIds = entries
          .filter(e => e.isDirectory())
          .map(e => e.name);
      } catch {
        // agents dir may not exist yet
      }

      const response = {
        object: 'list',
        data:   agentIds.map(id => ({
          id,
          object:   'model',
          created:  Math.floor(Date.now() / 1000),
          owned_by: 'sulla',
        })),
      };

      console.log('[ChatCompletionsAPI] Models response:', JSON.stringify(response, null, 2));
      res.json(response);
    } catch (error) {
      console.error('[ChatCompletionsAPI] Error handling models request:', error);
      res.status(500).json({
        error: {
          message: 'Internal server error',
          type:    'internal_error',
        },
      });
    }
  }

  /**
   * Handle completions requests (OpenAI-compatible single prompt).
   */
  public async handleCompletions(req: Request, res: Response) {
    try {
      const { model = 'sulla', prompt, max_tokens, temperature = 0.7 } = req.body;

      if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({
          error: {
            message: 'prompt string is required',
            type:    'invalid_request_error',
          },
        });
      }

      console.log(`[ChatCompletionsAPI] Processing completion for prompt: ${ prompt.substring(0, 100) }...`);

      // Reuse chat logic with single user message — model param is the agent ID
      const responseContent = await this.processUserInputDirect([{ role: 'user', content: prompt }], model);

      const response = {
        id:      `cmpl-${ Date.now() }`,
        object:  'text_completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          text:          responseContent,
          index:         0,
          logprobs:      null,
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens:     Math.ceil(prompt.length / 4),
          completion_tokens: Math.ceil(responseContent.length / 4),
          total_tokens:      Math.ceil(prompt.length / 4) + Math.ceil(responseContent.length / 4),
        },
      };

      console.log('[ChatCompletionsAPI] Completions response sent');
      res.json(response);
    } catch (error) {
      console.error('[ChatCompletionsAPI] Error handling completions request:', error);
      res.status(500).json({
        error: {
          message: 'Internal server error',
          type:    'internal_error',
        },
      });
    }
  }

  /**
   * Handle embeddings requests (OpenAI-compatible).
   */
  public async handleEmbeddings(req: Request, res: Response) {
    try {
      const { model, input, user } = req.body;

      if (!input) {
        return res.status(400).json({
          error: {
            message: 'input is required',
            type:    'invalid_request_error',
          },
        });
      }

      const inputs = Array.isArray(input) ? input : [input];
      const llamaBase = 'http://127.0.0.1:30114'; // llama-server base

      const embeddings = [];
      for (let i = 0; i < inputs.length; i++) {
        const prompt = inputs[i];
        if (typeof prompt !== 'string') continue;

        try {
          // llama-server uses OpenAI-compatible /v1/embeddings endpoint
          const response = await fetch(`${ llamaBase }/v1/embeddings`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ model: model || 'default', input: prompt }),
          });

          if (!response.ok) {
            throw new Error(`llama-server embeddings failed: ${ response.status }`);
          }

          const data = await response.json();
          const embedding = data.data?.[0]?.embedding || [];
          embeddings.push({
            object: 'embedding',
            embedding,
            index:  i,
          });
        } catch (error) {
          console.error('[ChatCompletionsAPI] Embeddings error:', error);
          // Return zero vector as fallback
          embeddings.push({
            object:    'embedding',
            embedding: new Array(768).fill(0), // Common embedding size
            index:     i,
          });
        }
      }

      const response = {
        object: 'list',
        data:   embeddings,
        model:  model || 'nomic-embed-text',
        usage:  {
          prompt_tokens: inputs.reduce((sum, inp) => sum + (typeof inp === 'string' ? Math.ceil(inp.length / 4) : 0), 0),
          total_tokens:  inputs.reduce((sum, inp) => sum + (typeof inp === 'string' ? Math.ceil(inp.length / 4) : 0), 0),
        },
      };

      console.log('[ChatCompletionsAPI] Embeddings response sent');
      res.json(response);
    } catch (error) {
      console.error('[ChatCompletionsAPI] Error handling embeddings request:', error);
      res.status(500).json({
        error: {
          message: 'Internal server error',
          type:    'internal_error',
        },
      });
    }
  }

  /**
   * Handle moderations requests (OpenAI-compatible).
   * Content moderation checks for harmful content like hate speech, violence, etc.
   * This implementation returns safe results since we're not using OpenAI's moderation.
   */
  public async handleModerations(req: Request, res: Response) {
    try {
      const { input } = req.body;

      if (!input) {
        return res.status(400).json({
          error: {
            message: 'input is required',
            type:    'invalid_request_error',
          },
        });
      }

      const inputs = Array.isArray(input) ? input : [input];
      const results = inputs.map(inp => ({
        categories: {
          hate:               false,
          'hate/threatening': false,
          'self-harm':        false,
          sexual:             false,
          'sexual/minors':    false,
          violence:           false,
          'violence/graphic': false,
        },
        category_scores: {
          hate:               0.0,
          'hate/threatening': 0.0,
          'self-harm':        0.0,
          sexual:             0.0,
          'sexual/minors':    0.0,
          violence:           0.0,
          'violence/graphic': 0.0,
        },
        flagged: false,
      }));

      const response = {
        id:      `modr-${ Date.now() }`,
        model:   'text-moderation-stable',
        results,
      };

      console.log('[ChatCompletionsAPI] Moderations response sent');
      res.json(response);
    } catch (error) {
      console.error('[ChatCompletionsAPI] Error handling moderations request:', error);
      res.status(500).json({
        error: {
          message: 'Internal server error',
          type:    'internal_error',
        },
      });
    }
  }

  // ── Integration API handlers ──────────────────────────────────────

  private async handleListIntegrations(req: Request, res: Response) {
    // v3 — enabled integrations with full endpoint schemas; MCP listed per-account
    // Supports ?search=<string> to filter by slug, name, or endpoint name/description
    try {
      const searchQuery = (req.query.search as string || '').trim().toLowerCase();
      const { getIntegrationConfigLoader } = await import('@pkg/agent/integrations/configApi');
      const { getIntegrationService } = await import('@pkg/agent/services/IntegrationService');
      const { integrations: catalogIntegrations } = await import('@pkg/agent/integrations/catalog');
      const loader = getIntegrationConfigLoader();
      await loader.loadAll(); // Ensure YAML configs are loaded before querying
      const svc = getIntegrationService();

      // IntegrationService is the source of truth for what's enabled
      const enabled = await svc.getEnabledIntegrations();

      // v4 — one entry per account, each with its own accountId + endpoints
      const tools: any[] = [];

      // ── Build native tool endpoints by category (for merging with integrations or standalone) ──
      const { toolRegistry } = await import('@pkg/agent/tools/registry');
      const { ToolRegistry } = await import('@pkg/agent/tools/registry');
      const INTERNAL_CATEGORIES = ['bridge', 'calendar', 'chrome', 'computer-use', 'docker', 'extensions', 'github', 'integrations', 'kubectl', 'lima', 'n8n', 'pg', 'playwright', 'rdctl', 'redis', 'slack'];

      // Individual stateless tools from mixed categories (where the rest of the category uses state)
      const INTERNAL_INDIVIDUAL_TOOLS = [
        { toolName: 'validate_sulla_workflow', slug: 'workflow' },
        { toolName: 'add_observational_memory', slug: 'memory' },
        { toolName: 'remove_observational_memory', slug: 'memory' },
        { toolName: 'check_agent_jobs', slug: 'agents' },
      ];

      const nativeEndpointsByCategory = new Map<string, any[]>();
      for (const category of INTERNAL_CATEGORIES) {
        const toolNames = toolRegistry.getToolNamesForCategory(category);
        const endpoints: any[] = [];
        for (const toolName of toolNames) {
          const schemaDef = toolRegistry.getSchemaDef(toolName);
          const description = toolRegistry.getToolDescription(toolName);
          if (!schemaDef && !description) continue;
          // Strip category prefix from endpoint name: "calendar_list" → "list"
          const endpointName = toolName.startsWith(`${ category }_`)
            ? toolName.slice(category.length + 1)
            : toolName;
          endpoints.push({
            name:        endpointName,
            method:      'POST',
            description,
            inputSchema: schemaDef ? ToolRegistry.schemaDefToJsonSchema(schemaDef) : { type: 'object', properties: {} },
          });
        }
        if (endpoints.length > 0) {
          nativeEndpointsByCategory.set(category, endpoints);
        }
      }

      // Track which categories got merged into an integration entry
      const mergedCategories = new Set<string>();

      for (const { integrationId, accounts } of enabled) {
        // ── MCP: each account is a separate MCP server ──
        if (integrationId === 'mcp') {
          try {
            const { MCPBridge } = await import('@pkg/agent/integrations/mcp/MCPBridge');
            const bridge = MCPBridge.getInstance();

            for (const account of accounts) {
              if (!account.connected) continue;

              // Lazy init: if this account has no live client, initialize it now
              let mcpTools = bridge.getToolsForAccount(account.account_id);
              if (mcpTools.length === 0) {
                try {
                  await bridge.initializeAccount(account.account_id);
                  mcpTools = bridge.getToolsForAccount(account.account_id);

                  // If tools were discovered, generate YAML configs so they persist
                  if (mcpTools.length > 0) {
                    await bridge.finalizeConfigs(account.account_id);
                    const { getIntegrationConfigLoader } = await import('@pkg/agent/integrations/configApi');
                    await getIntegrationConfigLoader().loadAll();
                  }
                } catch (initErr: any) {
                  console.warn(`[ChatCompletionsAPI] MCP lazy init failed for "${ account.account_id }":`, initErr.message);
                }
              }

              tools.push({
                accountId: account.account_id,
                label:     account.label || account.account_id,
                slug:      'mcp',
                name:      account.label || account.account_id,
                source:    'mcp',
                connected: account.connected,
                endpoints: mcpTools.map(tool => ({
                  name:        tool.name,
                  method:      'POST',
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                })),
              });
            }
          } catch (mcpErr: any) {
            console.warn('[ChatCompletionsAPI] MCP bridge not available:', mcpErr.message);
          }
          continue;
        }

        // ── YAML-based or native catalog — one entry per account ──
        const client = loader.getClient(integrationId);
        const catalogEntry = catalogIntegrations[integrationId];

        // Build endpoints once (shared across all accounts for this integration)
        let endpoints: any[] = [];
        if (client) {
          endpoints = client.endpointNames.map((epName) => {
            const ep = client.getEndpoint(epName);
            if (!ep) return null;

            const properties: Record<string, any> = {};
            const required: string[] = [];

            for (const [k, v] of Object.entries(ep.path_params || {})) {
              const param = v as any;
              const prop: any = { type: param.type || 'string', description: param.description || '' };
              if (param.enum) prop.enum = param.enum;
              if (param.default !== undefined) prop.default = param.default;
              if (param.format) prop.format = param.format;
              properties[k] = prop;
              if (param.required) required.push(k);
            }

            for (const [k, v] of Object.entries(ep.query_params || {})) {
              const param = v as any;
              const prop: any = { type: param.type || 'string', description: param.description || '' };
              if (param.enum) prop.enum = param.enum;
              if (param.default !== undefined) prop.default = param.default;
              if (param.format) prop.format = param.format;
              if (param.max !== undefined) prop.maximum = param.max;
              if (param.min !== undefined) prop.minimum = param.min;
              properties[k] = prop;
              if (param.required) required.push(k);
            }

            for (const [k, v] of Object.entries(ep.body_params || {})) {
              const param = v as any;
              const prop: any = { type: param.type || 'string', description: param.description || '' };
              if (param.enum) prop.enum = param.enum;
              if (param.default !== undefined) prop.default = param.default;
              if (param.format) prop.format = param.format;
              if (param.max !== undefined) prop.maximum = param.max;
              if (param.min !== undefined) prop.minimum = param.min;
              properties[k] = prop;
              if (param.required) required.push(k);
            }

            const endpoint: any = {
              name:        ep.endpoint.name,
              method:      ep.endpoint.method,
              description: ep.endpoint.description,
              inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
            };

            if (ep.response) endpoint.response = ep.response;
            if (ep.examples) endpoint.examples = ep.examples;

            return endpoint;
          }).filter(Boolean);
        }

        // Merge native tool endpoints if this integration slug matches a native category
        const nativeEps = nativeEndpointsByCategory.get(integrationId);
        const mergedEndpoints = nativeEps ? [...endpoints, ...nativeEps] : endpoints;
        if (nativeEps) mergedCategories.add(integrationId);

        for (const account of accounts) {
          tools.push({
            accountId: account.account_id,
            label:     account.label || account.account_id,
            slug:      integrationId,
            name:      client?.name || catalogEntry?.name || integrationId,
            source:    'integration',
            connected: account.connected,
            ...(catalogEntry?.category ? { category: catalogEntry.category } : {}),
            endpoints: mergedEndpoints,
          });
        }
      }

      // Add standalone internal categories that didn't match any integration
      for (const [category, endpoints] of nativeEndpointsByCategory) {
        if (mergedCategories.has(category)) continue;
        tools.push({
          accountId: 'internal',
          label:     'Internal Tools',
          slug:      category,
          name:      category,
          source:    'internal',
          connected: true,
          endpoints,
        });
      }

      // Add individual stateless tools from mixed categories, grouped by slug
      const individualBySlug = new Map<string, any[]>();
      for (const { toolName, slug } of INTERNAL_INDIVIDUAL_TOOLS) {
        const schemaDef = toolRegistry.getSchemaDef(toolName);
        const description = toolRegistry.getToolDescription(toolName);
        if (!schemaDef && !description) continue;
        const eps = individualBySlug.get(slug) || [];
        eps.push({
          name:        toolName,
          method:      'POST',
          description,
          inputSchema: schemaDef ? ToolRegistry.schemaDefToJsonSchema(schemaDef) : { type: 'object', properties: {} },
        });
        individualBySlug.set(slug, eps);
      }
      for (const [slug, endpoints] of individualBySlug) {
        tools.push({
          accountId: 'internal',
          label:     'Internal Tools',
          slug,
          name:      slug,
          source:    'internal',
          connected: true,
          endpoints,
        });
      }

      // Apply filters
      const sourceFilter = (req.query.source as string || '').trim().toLowerCase();
      const categoryFilter = (req.query.category as string || '').trim().toLowerCase();

      let filtered = tools;

      // Filter by source (internal, integration, mcp)
      if (sourceFilter) {
        const sources = new Set(sourceFilter.split(',').map(s => s.trim()));
        filtered = filtered.filter((entry: any) => sources.has(entry.source));
      }

      // Filter by category
      if (categoryFilter) {
        filtered = filtered.filter((entry: any) =>
          entry.category?.toLowerCase() === categoryFilter
          || entry.slug?.toLowerCase() === categoryFilter);
      }

      // Filter by search query (fuzzy match on slug, name, label, accountId, endpoint name/description)
      if (searchQuery) {
        filtered = filtered.filter((entry: any) => {
          if (entry.slug?.toLowerCase().includes(searchQuery)) return true;
          if (entry.name?.toLowerCase().includes(searchQuery)) return true;
          if (entry.label?.toLowerCase().includes(searchQuery)) return true;
          if (entry.accountId?.toLowerCase().includes(searchQuery)) return true;
          return entry.endpoints?.some((ep: any) =>
            ep.name?.toLowerCase().includes(searchQuery)
            || ep.description?.toLowerCase().includes(searchQuery),
          );
        });
      }

      res.json({
        success: true,
        version: 4,
        usage: {
          call_method: 'POST',
          call_url:    'http://host.docker.internal:3000/v1/tools/{accountId}/{slug}/{endpoint}/call',
          call_body:   '{"action": "upsert", "param_name": "value"}',
          notes:       'Each entry has a unique accountId + slug. Use them directly in the call URL. Send the inputSchema parameters as the JSON body — flat, no wrapper needed.',
        },
        tools: filtered,
      });
    } catch (error: any) {
      console.error('[ChatCompletionsAPI] Error listing integrations:', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to list integrations' });
    }
  }

  private async handleIntegrationCall(req: Request, res: Response) {
    const accountId = String(req.params.accountId);
    const slug = String(req.params.slug);
    const endpoint = String(req.params.endpoint);

    try {
      // Route internal tool calls — reconstruct full tool name from slug + endpoint
      if (accountId === 'internal') {
        const { toolRegistry } = await import('@pkg/agent/tools/registry');
        // Try prefixed name first (e.g. github + create_issue → github_create_issue),
        // then fall back to endpoint as-is (e.g. github + git_status → git_status)
        const prefixed = `${ slug }_${ endpoint }`;
        let tool = await toolRegistry.getTool(prefixed).catch(() => null);
        if (!tool) {
          tool = await toolRegistry.getTool(endpoint).catch(() => null);
        }
        if (!tool) {
          return res.status(404).json({ success: false, error: `Internal tool "${ prefixed }" or "${ endpoint }" not found` });
        }
        // Accept both { params: { ... } } and flat { action: "upsert", ... } formats
        const body = req.body || {};
        const params = body.params && typeof body.params === 'object' ? body.params : body;
        const result = await tool.call(params);
        return res.json({ success: true, result });
      }

      // Route MCP calls to the MCPBridge instead of ConfigApiClient
      if (slug === 'mcp') {
        const { MCPBridge } = await import('@pkg/agent/integrations/mcp/MCPBridge');
        const bridge = MCPBridge.getInstance();
        const { params = {} } = req.body || {};

        // Lazy init: if no client exists for this account, initialize on demand
        if (bridge.getToolsForAccount(accountId).length === 0) {
          await bridge.initializeAccount(accountId);
        }

        const result = await bridge.callTool(accountId, endpoint, params);
        return res.json({ success: true, result });
      }

      const { getIntegrationConfigLoader } = await import('@pkg/agent/integrations/configApi');
      const loader = getIntegrationConfigLoader();
      const client = loader.getClient(slug);

      if (!client) {
        const available = loader.getAvailableIntegrations();
        return res.status(404).json({
          success: false,
          error:   `Integration "${ slug }" not found. Available: ${ available.join(', ') }`,
        });
      }

      const epConfig = client.getEndpoint(endpoint);
      if (!epConfig) {
        return res.status(404).json({
          success: false,
          error:   `Endpoint "${ endpoint }" not found. Available: ${ client.endpointNames.join(', ') }`,
        });
      }

      const { params = {}, body, raw } = req.body || {};

      const result = await client.call(endpoint, params, {
        accountId,
        body,
        raw: !!raw,
      });

      res.json({ success: true, result: JSON.parse(JSON.stringify(result)) });
    } catch (error: any) {
      console.error(`[ChatCompletionsAPI] Integration call failed (${ slug }/${ endpoint }):`, error);
      res.status(500).json({ success: false, error: error.message || 'Integration call failed' });
    }
  }

  // ── MCP Config Generation handlers ─────────────────────────────

  private async handleMCPRegister(req: Request, res: Response) {
    const { account_id, server_url, auth_token, label } = req.body || {};

    if (!account_id || !server_url) {
      return res.status(400).json({ success: false, error: 'account_id and server_url are required' });
    }

    try {
      const { getIntegrationService } = await import('@pkg/agent/services/IntegrationService');
      const svc = getIntegrationService();

      const accountId = String(account_id);

      // Save credentials
      await svc.setIntegrationValue({ integration_id: 'mcp', account_id: accountId, property: 'server_url', value: String(server_url) });
      if (auth_token) {
        await svc.setIntegrationValue({ integration_id: 'mcp', account_id: accountId, property: 'auth_token', value: String(auth_token) });
      }
      if (label) {
        await svc.setIntegrationValue({ integration_id: 'mcp', account_id: accountId, property: 'account_label', value: String(label) });
      }

      // Mark as connected
      await svc.setConnectionStatus('mcp', true, accountId);

      res.json({ success: true, accountId, server_url, message: `MCP account "${ accountId }" registered. Call POST /v1/mcp/${ accountId }/discover to list tools, then POST /v1/mcp/${ accountId }/finalize to generate configs.` });
    } catch (error: any) {
      console.error('[ChatCompletionsAPI] MCP register failed:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  private async handleMCPDiscover(req: Request, res: Response) {
    const accountId = String(req.params.accountId);
    try {
      const { MCPBridge } = await import('@pkg/agent/integrations/mcp/MCPBridge');
      const bridge = MCPBridge.getInstance();
      const { tools, diff } = await bridge.discoverTools(accountId);

      res.json({
        success:   true,
        accountId,
        toolCount: tools.length,
        tools:     tools.map(t => ({
          name:        t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
        diff,
      });
    } catch (error: any) {
      console.error(`[ChatCompletionsAPI] MCP discover failed (${ accountId }):`, error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  private async handleMCPFinalize(req: Request, res: Response) {
    const accountId = String(req.params.accountId);
    try {
      const { MCPBridge } = await import('@pkg/agent/integrations/mcp/MCPBridge');
      const bridge = MCPBridge.getInstance();
      const result = await bridge.finalizeConfigs(accountId);

      // Reload the config loader so the new integration is immediately available
      const { getIntegrationConfigLoader } = await import('@pkg/agent/integrations/configApi');
      const loader = getIntegrationConfigLoader();
      await loader.loadAll();

      res.json({
        success: true,
        accountId,
        dirName:       result.dirName,
        endpointCount: result.endpointCount,
        toolNames:     result.toolNames,
      });
    } catch (error: any) {
      console.error(`[ChatCompletionsAPI] MCP finalize failed (${ accountId }):`, error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  private async handleMCPRefresh(req: Request, res: Response) {
    const accountId = String(req.params.accountId);
    try {
      const { MCPBridge } = await import('@pkg/agent/integrations/mcp/MCPBridge');
      const bridge = MCPBridge.getInstance();
      const { result, diff } = await bridge.refreshConfigs(accountId);

      // Reload the config loader
      const { getIntegrationConfigLoader } = await import('@pkg/agent/integrations/configApi');
      const loader = getIntegrationConfigLoader();
      await loader.loadAll();

      res.json({
        success: true,
        accountId,
        dirName:       result.dirName,
        endpointCount: result.endpointCount,
        toolNames:     result.toolNames,
        diff,
      });
    } catch (error: any) {
      console.error(`[ChatCompletionsAPI] MCP refresh failed (${ accountId }):`, error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  private async handleMCPDiscoverSource(req: Request, res: Response) {
    const { url, file_path, auth_token, account_id, label, server_name, auto_register } = req.body || {};

    if (!url && !file_path) {
      return res.status(400).json({ success: false, error: 'Provide either "url" or "file_path"' });
    }

    try {
      const { resolve } = await import('@pkg/agent/integrations/mcp/MCPSourceResolver');
      const result = await resolve({ url, file_path, auth_token, account_id, label, server_name, auto_register });

      // If resolution failed, return the probes + partial info
      if ('probes' in result) {
        return res.status(422).json({ success: false, ...result });
      }

      // If auto_register is requested, register + discover + finalize in one shot
      if (auto_register) {
        const { getIntegrationService } = await import('@pkg/agent/services/IntegrationService');
        const svc = getIntegrationService();
        const accountId = result.suggested_id;

        // Register credentials
        await svc.setIntegrationValue({ integration_id: 'mcp', account_id: accountId, property: 'server_url', value: result.resolved_url });
        if (result.auth_token) {
          await svc.setIntegrationValue({ integration_id: 'mcp', account_id: accountId, property: 'auth_token', value: result.auth_token });
        }
        await svc.setIntegrationValue({ integration_id: 'mcp', account_id: accountId, property: 'account_label', value: result.suggested_label });
        await svc.setConnectionStatus('mcp', true, accountId);

        // Initialize, finalize, reload
        const { MCPBridge } = await import('@pkg/agent/integrations/mcp/MCPBridge');
        const bridge = MCPBridge.getInstance();
        await bridge.initializeAccount(accountId);
        const genResult = await bridge.finalizeConfigs(accountId);

        const { getIntegrationConfigLoader } = await import('@pkg/agent/integrations/configApi');
        await getIntegrationConfigLoader().loadAll();

        return res.json({
          success: true,
          ...result,
          registered: true,
          finalized:  true,
          dir_name:   genResult.dirName,
        });
      }

      res.json({ success: true, ...result });
    } catch (error: any) {
      console.error('[ChatCompletionsAPI] MCP discover-source failed:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  private async handleMCPRemoveConfigs(req: Request, res: Response) {
    const accountId = String(req.params.accountId);
    try {
      const { MCPBridge } = await import('@pkg/agent/integrations/mcp/MCPBridge');
      const bridge = MCPBridge.getInstance();
      const removed = bridge.removeConfigs(accountId);

      if (removed) {
        // Reload the config loader so the integration disappears
        const { getIntegrationConfigLoader } = await import('@pkg/agent/integrations/configApi');
        const loader = getIntegrationConfigLoader();
        await loader.loadAll();
      }

      res.json({ success: true, accountId, removed });
    } catch (error: any) {
      console.error(`[ChatCompletionsAPI] MCP remove configs failed (${ accountId }):`, error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async start(port: number = CHAT_COMPLETIONS_PORT): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(port, '0.0.0.0', () => {
          console.log(`[ChatCompletionsAPI] Server listening on http://0.0.0.0:${ port }`);
          console.log(`[ChatCompletionsAPI] Health check: http://localhost:${ port }/health`);
          console.log(`[ChatCompletionsAPI] Chat completions: http://localhost:${ port }/chat/completions`);
          resolve();
        });

        this.server.on('error', (error: any) => {
          console.error('[ChatCompletionsAPI] Server error:', error);
          reject(error);
        });
      } catch (error) {
        console.error('[ChatCompletionsAPI] Failed to start server:', error);
        reject(error);
      }
    });
  }

  stop(): void {
    if (this.taskerUnsubscribe) {
      this.taskerUnsubscribe();
      this.taskerUnsubscribe = null;
    }

    if (this.server) {
      console.log('[ChatCompletionsAPI] Stopping server...');
      this.server.close(() => {
        console.log('[ChatCompletionsAPI] Server stopped');
      });
      this.server = null;
    }
  }
}

// Singleton instance
let chatCompletionsServer: ChatCompletionsServer | null = null;

export function getChatCompletionsServer(): ChatCompletionsServer {
  if (!chatCompletionsServer) {
    chatCompletionsServer = new ChatCompletionsServer();
  }
  return chatCompletionsServer;
}
