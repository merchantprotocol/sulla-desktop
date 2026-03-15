import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import fs from 'fs';
import path from 'path';

type JsonRecord = Record<string, unknown>;

interface N8nBridgeLogEvent {
  direction: 'lifecycle' | 'inbound' | 'error';
  action:    string;
  payload?:  unknown;
}

const N8N_BRIDGE_LOG_DIR = path.join(process.cwd(), 'log');
const N8N_BRIDGE_LOG_FILE = path.join(N8N_BRIDGE_LOG_DIR, 'agent-n8n-bridge.log');

function createPushRef(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to deterministic fallback.
  }

  return `rd-${ Date.now().toString(36) }-${ Math.random().toString(36).slice(2, 12) }`;
}

function writeN8nBridgeEvent(event: N8nBridgeLogEvent): void {
  try {
    let payloadText = '{}';
    try {
      payloadText = JSON.stringify(event.payload ?? {}, null, 2);
    } catch {
      payloadText = String(event.payload);
    }

    fs.mkdirSync(N8N_BRIDGE_LOG_DIR, { recursive: true });
    fs.appendFileSync(N8N_BRIDGE_LOG_FILE, [
      '---',
      `timestamp: ${ new Date().toISOString() }`,
      `direction: ${ event.direction }`,
      `action: ${ event.action }`,
      'payload:',
      payloadText,
      '',
    ].join('\n') + '\n', { encoding: 'utf-8' });
  } catch {
    // Ignore logging failures.
  }
}

export interface N8nBridgeConfig {
  baseUrl?:              string;
  wsPath?:               string;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?:  number;
}

export interface WorkflowUpdatedEvent {
  workflowId?: string;
  workflow?:   JsonRecord;
  raw:         unknown;
}

export interface ExecutionStartedEvent {
  executionId?: string;
  workflowId?:  string;
  raw:          unknown;
}

export interface NodeExecutedEvent {
  executionId?: string;
  workflowId?:  string;
  nodeName?:    string;
  raw:          unknown;
}

export interface ErrorOccurredEvent {
  message: string;
  code?:   string | number;
  raw:     unknown;
}

export interface N8nBridgeEventMap {
  connected:        { url: string };
  disconnected:     { code: number; reason: string };
  workflowUpdated:  WorkflowUpdatedEvent;
  executionStarted: ExecutionStartedEvent;
  nodeExecuted:     NodeExecutedEvent;
  errorOccurred:    ErrorOccurredEvent;
  rawMessage:       unknown;
}

type EventHandler<K extends keyof N8nBridgeEventMap> = (payload: N8nBridgeEventMap[K]) => void;

export class N8nBridgeService {
  private readonly baseUrl:              string;
  private readonly wsPath:               string;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs:  number;
  private readonly pushRef:              string;

  private socket:         WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private manuallyStopped = false;

  private readonly listeners: {
    [K in keyof N8nBridgeEventMap]?: Set<EventHandler<K>>;
  } = {};

  constructor(config: N8nBridgeConfig = {}) {
    this.baseUrl = config.baseUrl || 'http://127.0.0.1:30119';
    this.wsPath = config.wsPath || '/rest/push';
    this.reconnectBaseDelayMs = config.reconnectBaseDelayMs ?? 1_500;
    this.reconnectMaxDelayMs = config.reconnectMaxDelayMs ?? 30_000;
    this.pushRef = createPushRef();
  }

  private async isSessionAuthenticated(): Promise<boolean> {
    try {
      const response = await fetch(`${ this.baseUrl }/rest/workflows?limit=1`, {
        method:      'GET',
        credentials: 'include',
      });

      if (response.ok) {
        return true;
      }

      if (response.status === 401 || response.status === 403) {
        return false;
      }

      return true;
    } catch {
      return true;
    }
  }

  async start(): Promise<void> {
    this.manuallyStopped = false;
    await this.ensureAuthenticatedSession();
    writeN8nBridgeEvent({
      direction: 'lifecycle',
      action:    'bridge_start',
      payload:   { baseUrl: this.baseUrl, wsPath: this.wsPath },
    });
    await this.connectPush();
  }

  stop(): void {
    this.manuallyStopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      writeN8nBridgeEvent({ direction: 'lifecycle', action: 'bridge_stop' });
      this.socket.close();
      this.socket = null;
    }
  }

  on<K extends keyof N8nBridgeEventMap>(event: K, handler: EventHandler<K>): () => void {
    const bucket = (this.listeners[event] || new Set());
    bucket.add(handler);
    this.listeners[event] = bucket as (typeof this.listeners)[K];

    return () => this.off(event, handler);
  }

  off<K extends keyof N8nBridgeEventMap>(event: K, handler: EventHandler<K>): void {
    const bucket = this.listeners[event];
    bucket?.delete(handler);
  }

  getAppRootUrl(): string {
    try {
      const parsed = new URL(this.baseUrl);
      return `${ parsed.origin }/`;
    } catch {
      const trimmed = this.baseUrl.trim();
      if (!trimmed) {
        return '';
      }

      return trimmed.endsWith('/') ? trimmed : `${ trimmed }/`;
    }
  }

  async refreshAuthToken(): Promise<void> {
    const email = await SullaSettingsModel.get('n8nAuthEmail', await SullaSettingsModel.get('sullaEmail', ''));
    const password = await SullaSettingsModel.get('n8nAuthPassword', await SullaSettingsModel.get('sullaPassword', ''));

    if (!email || !password) {
      throw new Error('Cannot refresh n8n-auth token: missing credentials in settings');
    }

    const response = await fetch(`${ this.baseUrl }/rest/login`, {
      method:      'POST',
      credentials: 'include',
      headers:     {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        emailOrLdapLoginId: email,
        password,
        email,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 429) {
        throw new Error(`n8n login rate limited (429): ${ text || 'Too many requests, please try again later.' }`);
      }
      throw new Error(`n8n login failed ${ response.status } ${ response.statusText }: ${ text }`);
    }
  }

  async getWorkflow(workflowId: string): Promise<unknown> {
    return this.request(`/rest/workflows/${ encodeURIComponent(workflowId) }`);
  }

  async updateWorkflow(workflowId: string, workflow: JsonRecord): Promise<unknown> {
    return this.request(`/rest/workflows/${ encodeURIComponent(workflowId) }`, {
      method: 'PUT',
      body:   JSON.stringify(workflow),
    });
  }

  async runWorkflow(workflowId: string, data: JsonRecord = {}): Promise<unknown> {
    const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : {};

    try {
      return await this.request(`/rest/workflows/${ encodeURIComponent(workflowId) }/run`, {
        method: 'POST',
        body:   JSON.stringify(payload),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const needsWorkflowDataFallback = message.includes("Cannot read properties of undefined (reading 'id')") ||
        message.includes("Cannot read properties of undefined (reading 'nodeName')");
      if (!needsWorkflowDataFallback) {
        throw error;
      }

      const workflowResponse = await this.getWorkflow(workflowId);
      const workflowRecord = (workflowResponse && typeof workflowResponse === 'object' && !Array.isArray(workflowResponse))
        ? workflowResponse as JsonRecord
        : {};
      const workflowDataCandidate = (workflowRecord.data && typeof workflowRecord.data === 'object' && !Array.isArray(workflowRecord.data))
        ? workflowRecord.data as JsonRecord
        : workflowRecord;

      const workflowData: JsonRecord = {
        ...workflowDataCandidate,
        id: String((workflowDataCandidate.id as string) || (workflowRecord.id as string) || workflowId),
      };

      const runWithWorkflowDataPayload: JsonRecord = {
        workflowData,
        ...payload,
      };

      try {
        return await this.request(`/rest/workflows/${ encodeURIComponent(workflowId) }/run`, {
          method: 'POST',
          body:   JSON.stringify(runWithWorkflowDataPayload),
        });
      } catch (retryError) {
        const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
        const isNotFound = retryMessage.includes(' 404 ') || retryMessage.includes('Cannot POST');
        const retryNeedsWorkflowDataFallback = retryMessage.includes("Cannot read properties of undefined (reading 'id')") ||
          retryMessage.includes("Cannot read properties of undefined (reading 'nodeName')");
        if (!isNotFound && !retryNeedsWorkflowDataFallback) {
          throw retryError;
        }
      }

      return this.request('/rest/workflows/run', {
        method: 'POST',
        body:   JSON.stringify(runWithWorkflowDataPayload),
      });
    }
  }

  async request(endpoint: string, options: {
    method?:  string;
    body?:    string;
    headers?: Record<string, string>;
  } = {}): Promise<unknown> {
    await this.ensureAuthenticatedSession();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };

    const url = `${ this.baseUrl }${ endpoint.startsWith('/') ? endpoint : `/${ endpoint }` }`;
    const requestInit: RequestInit = {
      method:      options.method || 'GET',
      credentials: 'include',
      headers,
      body:        options.body,
    };

    let response = await fetch(url, requestInit);

    if (response.status === 401 || response.status === 403) {
      await this.refreshAuthToken();
      response = await fetch(url, requestInit);
    }

    if (!response.ok) {
      const text = await response.text();
      const error = `n8n request failed ${ response.status } ${ response.statusText }: ${ text }`;
      this.emit('errorOccurred', { message: error, code: response.status, raw: text });
      throw new Error(error);
    }

    if (response.status === 204) {
      return { ok: true };
    }

    return response.json();
  }

  private emit<K extends keyof N8nBridgeEventMap>(event: K, payload: N8nBridgeEventMap[K]): void {
    const bucket = this.listeners[event];
    if (!bucket) {
      return;
    }

    for (const handler of bucket) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[N8nBridgeService] Event handler failed for ${ String(event) }:`, error);
      }
    }
  }

  private async ensureAuthenticatedSession(): Promise<void> {
    const sessionActive = await this.isSessionAuthenticated();
    if (sessionActive) {
      return;
    }

    await this.refreshAuthToken();

    const sessionActiveAfterLogin = await this.isSessionAuthenticated();
    if (!sessionActiveAfterLogin) {
      throw new Error('n8n login did not establish an authenticated session');
    }
  }

  private async connectPush(): Promise<void> {
    if (this.manuallyStopped) {
      return;
    }

    const wsBaseUrl = this.baseUrl.replace(/^http/i, 'ws');
    const wsUrl = this.getPushWebSocketUrl(`${ wsBaseUrl }${ this.wsPath }`);

    this.socket = new WebSocket(wsUrl);

    this.socket.onopen = () => {
      this.reconnectAttempt = 0;
      writeN8nBridgeEvent({
        direction: 'lifecycle',
        action:    'ws_connected',
        payload:   { url: wsUrl },
      });
      this.emit('connected', { url: wsUrl });
    };

    this.socket.onmessage = (event: MessageEvent<string>) => {
      this.handleIncomingMessage(event.data);
    };

    this.socket.onerror = () => {
      writeN8nBridgeEvent({ direction: 'error', action: 'ws_error' });
      this.emit('errorOccurred', {
        message: 'n8n push websocket error',
        raw:     null,
      });
    };

    this.socket.onclose = (event: CloseEvent) => {
      writeN8nBridgeEvent({
        direction: 'lifecycle',
        action:    'ws_closed',
        payload:   {
          code:   event.code,
          reason: event.reason || '',
        },
      });
      this.emit('disconnected', { code: event.code, reason: event.reason || '' });
      this.socket = null;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.manuallyStopped || this.reconnectTimer) {
      return;
    }

    this.reconnectAttempt += 1;
    const baseDelay = this.reconnectBaseDelayMs * (2 ** Math.min(this.reconnectAttempt, 6));
    const delay = Math.min(baseDelay, this.reconnectMaxDelayMs);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureAuthenticatedSession()
        .then(() => this.connectPush())
        .catch((error) => {
          this.emit('errorOccurred', {
            message: error instanceof Error ? error.message : String(error),
            raw:     error,
          });
          this.scheduleReconnect();
        });
    }, delay);
  }

  private getPushWebSocketUrl(baseWsUrl: string): string {
    try {
      const url = new URL(baseWsUrl);
      url.searchParams.set('pushRef', this.pushRef);
      return url.toString();
    } catch {
      const separator = baseWsUrl.includes('?') ? '&' : '?';
      return `${ baseWsUrl }${ separator }pushRef=${ encodeURIComponent(this.pushRef) }`;
    }
  }

  private handleIncomingMessage(rawText: string): void {
    writeN8nBridgeEvent({
      direction: 'inbound',
      action:    'ws_raw_message',
      payload:   { rawText },
    });

    let payload: unknown = rawText;

    try {
      payload = JSON.parse(rawText);
    } catch {
      // Leave as raw string.
    }

    writeN8nBridgeEvent({
      direction: 'inbound',
      action:    'ws_parsed_message',
      payload,
    });

    this.emit('rawMessage', payload);

    const message = (payload && typeof payload === 'object') ? payload as JsonRecord : null;
    if (!message) {
      return;
    }

    const type = String(message.type || message.event || message.name || '').toLowerCase();

    if (type.includes('workflow') && (type.includes('update') || type.includes('saved') || type.includes('changed'))) {
      const workflowId = this.pickString(message, ['workflowId', 'id']);
      const workflow = this.pickObject(message, ['workflow', 'data']);
      this.emit('workflowUpdated', { workflowId, workflow, raw: payload });
      return;
    }

    if (type.includes('execution') && (type.includes('start') || type.includes('created'))) {
      this.emit('executionStarted', {
        executionId: this.pickString(message, ['executionId', 'id']),
        workflowId:  this.pickString(message, ['workflowId']),
        raw:         payload,
      });
      return;
    }

    if (type.includes('node') && (type.includes('executed') || type.includes('finished'))) {
      this.emit('nodeExecuted', {
        executionId: this.pickString(message, ['executionId']),
        workflowId:  this.pickString(message, ['workflowId']),
        nodeName:    this.pickString(message, ['nodeName', 'name']),
        raw:         payload,
      });
      return;
    }

    if (type.includes('error')) {
      this.emit('errorOccurred', {
        message: this.pickString(message, ['message', 'error']) || 'n8n push event error',
        code:    this.pickString(message, ['code']) || undefined,
        raw:     payload,
      });
    }
  }

  private pickString(message: JsonRecord, keys: string[]): string {
    for (const key of keys) {
      const value = message[key];
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }

    return '';
  }

  private pickObject(message: JsonRecord, keys: string[]): JsonRecord | undefined {
    for (const key of keys) {
      const value = message[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as JsonRecord;
      }
    }

    return undefined;
  }
}

let n8nBridgeServiceInstance: N8nBridgeService | null = null;

export function getN8nBridgeService(): N8nBridgeService {
  if (!n8nBridgeServiceInstance) {
    n8nBridgeServiceInstance = new N8nBridgeService();
  }

  return n8nBridgeServiceInstance;
}
