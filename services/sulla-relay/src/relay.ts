import crypto from 'node:crypto';

import { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';

import { bearerToken, tokenMatches, verifyDeviceToken } from './auth.js';

import type { RelayConfig } from './config.js';
import type {
  RelayEnvelope, RelayError, RelayToolCallEnvelope, RelayToolExecutionContext, RelayToolResultEnvelope,
} from '../../../pkg/rancher-desktop/runtime/relayProtocol.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

interface DeviceConnection {
  socket:       WebSocket;
  deviceId:     string;
  userId:       string;
  connectionId: string;
  inflight:     Set<string>;
  heartbeat:    ReturnType<typeof setInterval>;
}

interface PendingHttp {
  response:       ServerResponse;
  ownerReplicaId: string;
  deviceId:       string;
  timer:          ReturnType<typeof setTimeout>;
}

interface LocalRoute {
  originReplicaId: string;
  deviceId:        string;
  timer:           ReturnType<typeof setTimeout>;
}

type BusMessage =
  | { kind: 'call'; envelope: RelayToolCallEnvelope }
  | { kind: 'result'; envelope: RelayToolResultEnvelope }
  | { kind: 'cancel'; requestId: string; deviceId: string };

const presenceKey = (deviceId: string) => `sulla:relay:device:${ deviceId }`;
const replicaChannel = (replicaId: string) => `sulla:relay:replica:${ replicaId }`;

function relayError(code: RelayError['code'], message: string, retryable = false): RelayError {
  return { code, message, ...(retryable ? { retryable: true } : {}) };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  const encoded = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) });
  response.end(encoded);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('Request body exceeds 2 MB');
    chunks.push(Buffer.from(chunk));
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object required');
  return parsed as Record<string, unknown>;
}

export class RelayService {
  readonly webSockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  private readonly redis:      Redis;
  private readonly subscriber: Redis;
  private readonly devices = new Map<string, DeviceConnection>();
  private readonly pendingHttp = new Map<string, PendingHttp>();
  private readonly localRoutes = new Map<string, LocalRoute>();

  constructor(private readonly config: RelayConfig) {
    this.redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    this.subscriber = this.redis.duplicate();
  }

  async start(): Promise<void> {
    await Promise.all([this.redis.connect(), this.subscriber.connect()]);
    await this.subscriber.subscribe(replicaChannel(this.config.replicaId));
    this.subscriber.on('message', (_channel: string, raw: string) => this.onBusMessage(raw));
    this.webSockets.on('connection', (socket, request) => {
      this.acceptDevice(socket, request).catch(error => console.error('[sulla-relay] Device admission failed:', error));
    });
  }

  async stop(): Promise<void> {
    for (const connection of this.devices.values()) {
      clearInterval(connection.heartbeat);
      connection.socket.close(1012, 'relay_shutdown');
    }
    for (const pending of this.pendingHttp.values()) clearTimeout(pending.timer);
    for (const route of this.localRoutes.values()) clearTimeout(route.timer);
    this.pendingHttp.clear();
    this.localRoutes.clear();
    this.webSockets.close();
    await Promise.all([this.redis.quit(), this.subscriber.quit()]);
  }

  async healthy(): Promise<boolean> {
    return await this.redis.ping() === 'PONG';
  }

  upgrade(request: IncomingMessage, socket: any, head: Buffer): void {
    const url = new URL(request.url ?? '/', 'http://relay');
    if (url.pathname !== '/v1/tunnel') { socket.destroy(); return }
    try {
      const token = bearerToken(request.headers.authorization) || url.searchParams.get('token') || '';
      const claims = verifyDeviceToken(token, this.config.deviceTokenSecret);
      const requestedDevice = url.searchParams.get('deviceId');
      if (requestedDevice && requestedDevice !== claims.device_id) throw new Error('Device token does not match requested device');
      (request as IncomingMessage & { relayClaims?: typeof claims }).relayClaims = claims;
      this.webSockets.handleUpgrade(request, socket, head, ws => this.webSockets.emit('connection', ws, request));
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  }

  async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://relay');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      try { sendJson(response, 200, { ok: await this.healthy(), replicaId: this.config.replicaId, devices: this.devices.size }) } catch {
        sendJson(response, 503, { ok: false, error: 'redis_unavailable' });
      }
      return;
    }
    const match = /^\/v1\/devices\/([^/]+)\/tools\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (request.method !== 'POST' || !match) { sendJson(response, 404, { error: relayError('BAD_REQUEST', 'Route not found') }); return }
    if (!tokenMatches(bearerToken(request.headers.authorization), this.config.internalToken)) {
      sendJson(response, 401, { error: relayError('FORBIDDEN', 'Invalid relay service token') }); return;
    }
    let body: Record<string, unknown>;
    try { body = await readJson(request) } catch (error) {
      sendJson(response, 400, { error: relayError('BAD_REQUEST', error instanceof Error ? error.message : String(error)) }); return;
    }
    const [deviceId, category, tool] = match.slice(1).map(decodeURIComponent);
    const ctx = body.ctx as RelayToolExecutionContext | undefined;
    const requestedDeadline = Number(body.deadlineMs);
    if (!ctx || typeof ctx.sub !== 'string' || !ctx.request_id || !Number.isFinite(requestedDeadline) || requestedDeadline <= 0) {
      sendJson(response, 400, { error: relayError('BAD_REQUEST', 'ctx and a positive deadlineMs are required') }); return;
    }
    const presence = await this.getPresence(deviceId);
    if (!presence) { sendJson(response, 503, { error: relayError('DEVICE_OFFLINE', 'Desktop device is offline', true) }); return }
    if (ctx.sub !== presence.userId || (ctx.device_id && ctx.device_id !== deviceId)) {
      sendJson(response, 403, { error: relayError('FORBIDDEN', 'Tool context does not match the target Desktop') }); return;
    }
    const deadlineMs = Math.min(requestedDeadline, this.config.maxDeadlineMs);
    const requestId = ctx.request_id || crypto.randomUUID();
    if (this.pendingHttp.has(requestId)) {
      sendJson(response, 400, { error: relayError('BAD_REQUEST', 'request_id is already in flight') }); return;
    }
    const envelope: RelayToolCallEnvelope = {
      type:            'tool-call',
      action:          'execute',
      requestId,
      deviceId,
      originReplicaId: this.config.replicaId,
      ctx,
      category,
      tool,
      args:            body.args,
      deadlineAt:      Date.now() + deadlineMs,
    };
    const timer = setTimeout(() => {
      this.timeoutRequest(requestId).catch(error => console.error('[sulla-relay] Timeout cleanup failed:', error));
    }, deadlineMs);
    this.pendingHttp.set(requestId, { response, ownerReplicaId: presence.replicaId, deviceId, timer });
    response.on('close', () => {
      if (!response.writableEnded && this.pendingHttp.has(requestId)) {
        this.cancelRequest(requestId).catch(error => console.error('[sulla-relay] Cancellation failed:', error));
      }
    });
    if (presence.replicaId === this.config.replicaId) this.dispatchLocal(envelope);
    else if (await this.publish(presence.replicaId, { kind: 'call', envelope }) === 0) {
      this.finishHttp({
        type:  'tool-result',
        requestId,
        deviceId,
        error: relayError('DEVICE_OFFLINE', 'Desktop relay replica is offline', true),
      });
    }
  }

  private async acceptDevice(socket: WebSocket, request: IncomingMessage): Promise<void> {
    const claims = (request as IncomingMessage & { relayClaims?: { sub: string; device_id: string } }).relayClaims;
    if (!claims) { socket.close(1008, 'unauthorized'); return }
    const previous = this.devices.get(claims.device_id);
    previous?.socket.close(1008, 'superseded');
    const connectionId = crypto.randomUUID();
    const connection: DeviceConnection = {
      socket,
      deviceId:  claims.device_id,
      userId:    claims.sub,
      connectionId,
      inflight:  new Set(),
      heartbeat: setInterval(() => {
        this.refreshPresence(claims.device_id, connectionId).catch(error => console.error('[sulla-relay] Presence refresh failed:', error));
      }, Math.max(5_000, this.config.presenceTtlSeconds * 500)),
    };
    this.devices.set(claims.device_id, connection);
    await this.writePresence(connection);
    socket.on('message', raw => {
      this.onDeviceMessage(connection, String(raw)).catch(error => console.error('[sulla-relay] Device message failed:', error));
    });
    socket.on('close', () => {
      this.removeDevice(connection).catch(error => console.error('[sulla-relay] Device removal failed:', error));
    });
    socket.on('error', () => {
      this.removeDevice(connection).catch(error => console.error('[sulla-relay] Device removal failed:', error));
    });
  }

  private async writePresence(connection: DeviceConnection): Promise<void> {
    await this.redis.set(presenceKey(connection.deviceId), JSON.stringify({
      replicaId: this.config.replicaId, userId: connection.userId, connectionId: connection.connectionId,
    }), 'EX', this.config.presenceTtlSeconds);
  }

  private async refreshPresence(deviceId: string, connectionId: string): Promise<void> {
    const connection = this.devices.get(deviceId);
    if (connection?.connectionId !== connectionId) return;
    const current = await this.getPresence(deviceId);
    if (current && current.connectionId !== connectionId) {
      connection.socket.close(1008, 'superseded');
      return;
    }
    await this.writePresence(connection);
  }

  private async removeDevice(connection: DeviceConnection): Promise<void> {
    if (this.devices.get(connection.deviceId)?.connectionId !== connection.connectionId) return;
    this.devices.delete(connection.deviceId);
    clearInterval(connection.heartbeat);
    const current = await this.getPresence(connection.deviceId);
    if (current?.connectionId === connection.connectionId) await this.redis.del(presenceKey(connection.deviceId));
  }

  private async getPresence(deviceId: string): Promise<{ replicaId: string; userId: string; connectionId: string } | null> {
    const raw = await this.redis.get(presenceKey(deviceId));
    if (!raw) return null;
    try { return JSON.parse(raw) } catch { return null }
  }

  private dispatchLocal(envelope: RelayToolCallEnvelope): void {
    const connection = this.devices.get(envelope.deviceId);
    if (connection?.socket.readyState !== WebSocket.OPEN) {
      this.routeResult(envelope.originReplicaId!, {
        type:      'tool-result',
        requestId: envelope.requestId,
        deviceId:  envelope.deviceId,
        error:     relayError('DEVICE_OFFLINE', 'Desktop device is offline', true),
      }).catch(error => console.error('[sulla-relay] Result routing failed:', error));
      return;
    }
    if (envelope.ctx?.sub !== connection.userId) {
      this.routeResult(envelope.originReplicaId!, {
        type:      'tool-result',
        requestId: envelope.requestId,
        deviceId:  envelope.deviceId,
        error:     relayError('FORBIDDEN', 'Tool context does not match connected Desktop'),
      }).catch(error => console.error('[sulla-relay] Result routing failed:', error));
      return;
    }
    if (connection.inflight.size >= this.config.maxInFlightPerDevice) {
      this.routeResult(envelope.originReplicaId!, {
        type:      'tool-result',
        requestId: envelope.requestId,
        deviceId:  envelope.deviceId,
        error:     relayError('BACKPRESSURE', 'Desktop has reached its in-flight tool-call limit', true),
      }).catch(error => console.error('[sulla-relay] Result routing failed:', error));
      return;
    }
    connection.inflight.add(envelope.requestId);
    const timer = setTimeout(() => {
      connection.inflight.delete(envelope.requestId);
      this.localRoutes.delete(envelope.requestId);
      this.sendToDevice(connection, { type: 'tool-call', action: 'cancel', requestId: envelope.requestId, deviceId: envelope.deviceId });
    }, Math.max(1, (envelope.deadlineAt ?? Date.now()) - Date.now()));
    this.localRoutes.set(envelope.requestId, { originReplicaId: envelope.originReplicaId!, deviceId: envelope.deviceId, timer });
    this.sendToDevice(connection, envelope);
  }

  private async onDeviceMessage(connection: DeviceConnection, raw: string): Promise<void> {
    let envelope: RelayEnvelope;
    try { envelope = JSON.parse(raw) as RelayEnvelope } catch { return }
    if (envelope.type !== 'tool-result' || envelope.deviceId !== connection.deviceId) return;
    const route = this.localRoutes.get(envelope.requestId);
    if (!route) return;
    clearTimeout(route.timer);
    this.localRoutes.delete(envelope.requestId);
    connection.inflight.delete(envelope.requestId);
    await this.routeResult(route.originReplicaId, envelope);
  }

  private async routeResult(originReplicaId: string, envelope: RelayToolResultEnvelope): Promise<void> {
    if (originReplicaId === this.config.replicaId) this.finishHttp(envelope);
    else await this.publish(originReplicaId, { kind: 'result', envelope });
  }

  private finishHttp(envelope: RelayToolResultEnvelope): void {
    const pending = this.pendingHttp.get(envelope.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingHttp.delete(envelope.requestId);
    const status = envelope.error?.code === 'FORBIDDEN'
      ? 403
      : envelope.error?.code === 'DEVICE_OFFLINE'
        ? 503
        : envelope.error?.code === 'BACKPRESSURE'
          ? 429
          : envelope.error?.code === 'DEADLINE_EXCEEDED' ? 504 : envelope.error ? 500 : 200;
    sendJson(pending.response, status, envelope.error ? { error: envelope.error } : { result: envelope.result });
  }

  private async timeoutRequest(requestId: string): Promise<void> {
    const pending = this.pendingHttp.get(requestId);
    if (!pending) return;
    this.pendingHttp.delete(requestId);
    sendJson(pending.response, 504, { error: relayError('DEADLINE_EXCEEDED', 'Desktop tool call deadline exceeded', true) });
    await this.publishOrCancelLocal(pending.ownerReplicaId, requestId, pending.deviceId);
  }

  private async cancelRequest(requestId: string): Promise<void> {
    const pending = this.pendingHttp.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingHttp.delete(requestId);
    await this.publishOrCancelLocal(pending.ownerReplicaId, requestId, pending.deviceId);
  }

  private async publishOrCancelLocal(ownerReplicaId: string, requestId: string, deviceId: string): Promise<void> {
    if (ownerReplicaId === this.config.replicaId) this.cancelLocal(requestId, deviceId);
    else await this.publish(ownerReplicaId, { kind: 'cancel', requestId, deviceId });
  }

  private cancelLocal(requestId: string, deviceId: string): void {
    const route = this.localRoutes.get(requestId);
    if (route) clearTimeout(route.timer);
    this.localRoutes.delete(requestId);
    const connection = this.devices.get(deviceId);
    connection?.inflight.delete(requestId);
    if (connection) this.sendToDevice(connection, { type: 'tool-call', action: 'cancel', requestId, deviceId });
  }

  private sendToDevice(connection: DeviceConnection, envelope: RelayEnvelope): void {
    connection.socket.send(JSON.stringify(envelope));
  }

  private async publish(replicaId: string, message: BusMessage): Promise<number> {
    return await this.redis.publish(replicaChannel(replicaId), JSON.stringify(message));
  }

  private onBusMessage(raw: string): void {
    let message: BusMessage;
    try { message = JSON.parse(raw) as BusMessage } catch { return }
    if (message.kind === 'call') this.dispatchLocal(message.envelope);
    else if (message.kind === 'result') this.finishHttp(message.envelope);
    else this.cancelLocal(message.requestId, message.deviceId);
  }
}
