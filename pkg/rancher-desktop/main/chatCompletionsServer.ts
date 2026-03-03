import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { GraphRegistry, nextThreadId, nextMessageId } from '@pkg/agent/services/GraphRegistry';
import { getWebSocketClientService, type WebSocketMessage } from '@pkg/agent/services/WebSocketClientService';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getSettings } from '@pkg/config/settingsImpl';

const CHAT_COMPLETIONS_PORT = parseInt('3000', 10);
const WS_CHANNEL = 'tasker';

export class ChatCompletionsServer {
  private app = express();
  private server: any = null;
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
          id: nextMessageId(),
          role: 'user',
          content,
          timestamp: Date.now(),
          metadata: { source: 'tasker', origin: metadata?.origin || 'unknown' },
        },
      ]);

      if (!responseText.trim()) {
        return;
      }

      await this.wsService.send(WS_CHANNEL, {
        type: 'assistant_message',
        data: {
          role: 'assistant',
          content: responseText,
          metadata: {
            origin: 'tasker_router',
            replyToId: msg.id,
            requestOrigin: metadata?.origin,
            requestEventType: metadata?.eventType,
            slackChannel: metadata?.channel,
            slackThreadTs: metadata?.threadTs,
            slackUser: metadata?.user,
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

    console.log('[ChatCompletionsAPI] Tasker listener received message', {
      type: msg.type,
      id: msg.id,
      channel: msg.channel,
      contentPreview: content.slice(0, 80),
      metadataOrigin: metadata?.origin,
      metadataEventType: metadata?.eventType,
    });

    if (msg.type === 'user_message' && metadata?.origin === 'slack' && metadata?.eventType === 'app_mention') {
      console.log('[ChatCompletionsAPI] Tasker listener received Slack app_mention trigger', {
        id: msg.id,
        slackChannel: metadata?.channel,
        slackThreadTs: metadata?.threadTs,
        slackUser: metadata?.user,
      });
    }
  }

  /**
   * Setup the middleware for the chat completions server.
   */
  private setupMiddleware() {
    // Enable CORS for all origins (since this is a public API)
    this.app.use(cors({
      origin: true, // Allow all origins
      credentials: true
    }));

    // Parse JSON bodies
    this.app.use(express.json({ limit: '10mb' }));

    // Add request logging
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      console.log(`[ChatCompletionsAPI] ${req.method} ${req.path}`);
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
    this.app.get('/v1/models', async (req: Request, res: Response) => {
      await this.handleModels(req, res);
    });

    // OpenAI-compatible chat completions endpoint
    this.app.post('/v1/chat/completions', async (req: Request, res: Response) => {
      await this.handleChatCompletions(req, res);
    });

    // OpenAI-compatible completions endpoint
    this.app.post('/v1/completions', async (req: Request, res: Response) => {
      await this.handleCompletions(req, res);
    });

    // OpenAI-compatible embeddings endpoint
    this.app.post('/v1/embeddings', async (req: Request, res: Response) => {
      await this.handleEmbeddings(req, res);
    });

    // OpenAI-compatible moderations endpoint
    this.app.post('/v1/moderations', async (req: Request, res: Response) => {
      await this.handleModerations(req, res);
    });

    // Catch-all for unknown routes
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({
        error: {
          message: `Endpoint ${req.method} ${req.path} not found`,
          type: 'invalid_request_error'
        }
      });
    });
  }

  /**
   * Handle chat completions requests.
   */
  public async handleChatCompletions(req: Request, res: Response) {
    try {
      console.log('[ChatCompletionsAPI] Incoming request body:', JSON.stringify(req.body, null, 2));

      const { messages, model = 'sulla', temperature = 0.7, max_tokens, stream = false } = req.body;

      // Validate request
      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({
          error: {
            message: 'messages array is required',
            type: 'invalid_request_error'
          }
        });
      }

      // Get the last message
      const lastMessage = messages[messages.length - 1];

      // For streaming responses, we'd need to implement SSE
      if (stream) {
        return res.status(400).json({
          error: {
            message: 'Streaming is not yet implemented',
            type: 'not_implemented'
          }
        });
      }

      // Extract the user message content
      const userText = typeof lastMessage.content === 'string'
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);

      console.log(`[ChatCompletionsAPI] Processing message: ${userText.substring(0, 100)}...`);

      // Process the user input directly
      const responseContent = await this.processUserInputDirect(messages);

      // Return the response in OpenAI format
      const response = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: responseContent
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: Math.ceil(userText.length / 4), // Rough estimate
          completion_tokens: Math.ceil(responseContent.length / 4), // Rough estimate
          total_tokens: Math.ceil(userText.length / 4) + Math.ceil(responseContent.length / 4)
        }
      };

      console.log('[ChatCompletionsAPI] Outgoing response:', JSON.stringify(response, null, 2));
      console.log(`[ChatCompletionsAPI] Response sent`);
      res.json(response);

    } catch (error) {
      console.error('[ChatCompletionsAPI] Error handling chat completion:', error);
      res.status(500).json({
        error: {
          message: 'Internal server error',
          type: 'internal_error'
        }
      });
    }
  }

  /**
   * Process user input directly, without any UI interaction.
   * This is used for testing and development purposes.
   */
  private async processUserInputDirect(messages: any): Promise<string> {
    const threadId = nextThreadId();
    
    // Get or create persistent AgentGraph for this thread
    const { graph, state } = await GraphRegistry.getOrCreateAgentGraph(WS_CHANNEL, threadId);

    try {
      state.metadata.wsChannel = WS_CHANNEL;

      // Append new user messages
      for (const msg of messages) {
        state.messages.push({
          id: msg.id || nextMessageId(),
          role: msg.role || 'user',
          content: msg.content,
          timestamp: msg.timestamp || Date.now(),
          metadata: msg.metadata || { source: 'api' },
        });
      }

      // Reset pause flags when real user input comes in
      state.metadata.cycleComplete = false;
      state.metadata.waitingForUser = false;

      // Execute on the persistent AgentGraph starting from input_handler
      await graph.execute(state, 'input_handler');

      // Extract response: check agent metadata first, then fall back to latest assistant message
      const agentMeta = (state.metadata as any).agent;
      if (agentMeta?.response?.trim()) return agentMeta.response.trim();
      if (agentMeta?.status_report?.trim()) return agentMeta.status_report.trim();

      const finalSummary = state.metadata.finalSummary?.trim();
      if (finalSummary) return finalSummary;

      const latestAssistant = [...state.messages].reverse().find((msg: any) => msg.role === 'assistant');
      if (latestAssistant?.content) {
        return typeof latestAssistant.content === 'string'
          ? latestAssistant.content
          : JSON.stringify(latestAssistant.content);
      }

      return '';

    } catch (err: any) {
      console.error('[ChatCompletionsAPI] Error processing user input:', err);
      return `Error: ${err.message || String(err)}`;
    } finally {
      // Reset here — after graph run completes
      state.metadata.consecutiveSameNode = 0;
      state.metadata.iterations = 0;
    }
  }

  /**
   * Handle models requests (OpenAI-compatible).
   */
  public async handleModels(req: Request, res: Response) {
    try {
      let models: string[] = [];

      // Always include available Ollama models (filtered by CPU/RAM)
      const settings = getSettings();
      const numCPUs = settings.virtualMachine?.numberCPUs || 2;
      const memoryGB = settings.virtualMachine?.memoryInGB || 4;

      const allOllamaModels = [
        'tinyllama:latest',
        'llama2:7b',
        'llama2:13b',
        'llama3:8b',
        'llama3:70b',
        'codellama:7b',
        'codellama:13b'
      ];

      const modelRequirements: Record<string, { ram: number, cpu: number }> = {
        'tinyllama:latest': { ram: 1, cpu: 1 },
        'llama2:7b': { ram: 8, cpu: 4 },
        'llama2:13b': { ram: 16, cpu: 8 },
        'llama3:8b': { ram: 16, cpu: 4 },
        'llama3:70b': { ram: 40, cpu: 8 },
        'codellama:7b': { ram: 8, cpu: 4 },
        'codellama:13b': { ram: 16, cpu: 8 },
      };

      const availableOllamaModels = allOllamaModels.filter(model =>
        modelRequirements[model] &&
        modelRequirements[model].ram <= memoryGB &&
        modelRequirements[model].cpu <= numCPUs
      );

      models.push(...availableOllamaModels);

      const remoteProvider = await SullaSettingsModel.get('remoteProvider', 'grok');
      const remoteApiKey = await SullaSettingsModel.get('remoteApiKey', '');
      const isGrokConfigured: boolean = remoteProvider === 'grok' && remoteApiKey.startsWith('xai-');
      const isOpenAiConfigured: boolean = remoteProvider === 'openai' && remoteApiKey.startsWith('sk-') && remoteApiKey.length > 50;
      
      // Add remote models if configured
      if (isGrokConfigured) {
        // Grok models
        models.push(
          'grok-beta',
          'grok-1',
          'grok-2-1212',
          'grok-2',
          'grok-1.5',
          'grok-1.5v2',
          'grok-2-1212',
          'grok-vision-beta',
          'grok-2-vision-1212'
        );
      } else if (isOpenAiConfigured) {
        // OpenAI models
        models.push(
          'gpt-3.5-turbo',
          'gpt-3.5-turbo-16k',
          'gpt-4',
          'gpt-4-32k',
          'gpt-4-turbo-preview',
          'gpt-4-vision-preview',
          'gpt-4o',
          'gpt-4o-mini'
        );
      }

      const response = {
        object: 'list',
        data: models.map(model => ({
          id: model,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: model.includes('grok') ? 'xai' : model.includes('gpt') ? 'openai' : 'ollama'
        }))
      };

      console.log('[ChatCompletionsAPI] Models response:', JSON.stringify(response, null, 2));
      res.json(response);
    } catch (error) {
      console.error('[ChatCompletionsAPI] Error handling models request:', error);
      res.status(500).json({
        error: {
          message: 'Internal server error',
          type: 'internal_error'
        }
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
            type: 'invalid_request_error'
          }
        });
      }

      console.log(`[ChatCompletionsAPI] Processing completion for prompt: ${prompt.substring(0, 100)}...`);

      // Reuse chat logic with single user message
      const responseContent = await this.processUserInputDirect([{ role: 'user', content: prompt }]);

      const response = {
        id: `cmpl-${Date.now()}`,
        object: 'text_completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
          text: responseContent,
          index: 0,
          logprobs: null,
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: Math.ceil(prompt.length / 4),
          completion_tokens: Math.ceil(responseContent.length / 4),
          total_tokens: Math.ceil(prompt.length / 4) + Math.ceil(responseContent.length / 4)
        }
      };

      console.log('[ChatCompletionsAPI] Completions response sent');
      res.json(response);
    } catch (error) {
      console.error('[ChatCompletionsAPI] Error handling completions request:', error);
      res.status(500).json({
        error: {
          message: 'Internal server error',
          type: 'internal_error'
        }
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
            type: 'invalid_request_error'
          }
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
          const response = await fetch(`${llamaBase}/v1/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: model || 'default', input: prompt })
          });

          if (!response.ok) {
            throw new Error(`llama-server embeddings failed: ${response.status}`);
          }

          const data = await response.json();
          const embedding = data.data?.[0]?.embedding || [];
          embeddings.push({
            object: 'embedding',
            embedding,
            index: i
          });
        } catch (error) {
          console.error('[ChatCompletionsAPI] Embeddings error:', error);
          // Return zero vector as fallback
          embeddings.push({
            object: 'embedding',
            embedding: new Array(768).fill(0), // Common embedding size
            index: i
          });
        }
      }

      const response = {
        object: 'list',
        data: embeddings,
        model: model || 'nomic-embed-text',
        usage: {
          prompt_tokens: inputs.reduce((sum, inp) => sum + (typeof inp === 'string' ? Math.ceil(inp.length / 4) : 0), 0),
          total_tokens: inputs.reduce((sum, inp) => sum + (typeof inp === 'string' ? Math.ceil(inp.length / 4) : 0), 0)
        }
      };

      console.log('[ChatCompletionsAPI] Embeddings response sent');
      res.json(response);
    } catch (error) {
      console.error('[ChatCompletionsAPI] Error handling embeddings request:', error);
      res.status(500).json({
        error: {
          message: 'Internal server error',
          type: 'internal_error'
        }
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
            type: 'invalid_request_error'
          }
        });
      }

      const inputs = Array.isArray(input) ? input : [input];
      const results = inputs.map(inp => ({
        categories: {
          hate: false,
          'hate/threatening': false,
          'self-harm': false,
          sexual: false,
          'sexual/minors': false,
          violence: false,
          'violence/graphic': false
        },
        category_scores: {
          hate: 0.0,
          'hate/threatening': 0.0,
          'self-harm': 0.0,
          sexual: 0.0,
          'sexual/minors': 0.0,
          violence: 0.0,
          'violence/graphic': 0.0
        },
        flagged: false
      }));

      const response = {
        id: `modr-${Date.now()}`,
        model: 'text-moderation-stable',
        results: results
      };

      console.log('[ChatCompletionsAPI] Moderations response sent');
      res.json(response);
    } catch (error) {
      console.error('[ChatCompletionsAPI] Error handling moderations request:', error);
      res.status(500).json({
        error: {
          message: 'Internal server error',
          type: 'internal_error'
        }
      });
    }
  }

  async start(port: number = CHAT_COMPLETIONS_PORT): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(port, '0.0.0.0', () => {
          console.log(`[ChatCompletionsAPI] Server listening on http://0.0.0.0:${port}`);
          console.log(`[ChatCompletionsAPI] Health check: http://localhost:${port}/health`);
          console.log(`[ChatCompletionsAPI] Chat completions: http://localhost:${port}/chat/completions`);
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