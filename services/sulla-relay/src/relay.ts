// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';

import { bearerToken, tokenMatches, verifyDeviceToken } from './auth.js';
import { RedisHealthProbe } from './RedisHealthProbe.js';
import { RelayRequestLedger } from './RequestLedger.js';
import { ToolDeadlinePolicy } from '../../../packages/runtime-protocol/src/toolDeadlinePolicy.js';
import { RELAY_TOOL_RESULT_MAX_BYTES, RELAY_TUNNEL_WIRE_MAX_BYTES } from '../../../packages/relay-protocol/src/relayProtocol.js';

import type { RelayConfig } from './config.js';
import type {
  RelayEnvelope, RelayError, RelayToolCallEnvelope, RelayToolExecutionContext, RelayToolResultEnvelope,
} from '../../../packages/relay-protocol/src/relayProtocol.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

interface DeviceConnection {
  socket:       WebSocket;
  deviceId:     string;
  userId:       string;
  connectionId: string;
  inflight:     Set<string>;
  heartbeat:    ReturnType<typeof setInterval>;
  heartbeatNonce: string | null;
  heartbeatSentAt: number;
  heartbeatRtts: number[];
  lastHeartbeatRttMs: number;
}

interface PendingHttp {
  response:       ServerResponse;
  ownerReplicaId: string;
  deviceId:       string;
  timer:          ReturnType<typeof setTimeout>;
  category:       string;
  tool:           string;
  operationTypes: string[];
  startedAt:      number;
  deadlineMs:     number;
  fingerprint:    string;
  requestId:      string;
}

interface LocalRoute {
  originReplicaId: string;
  deviceId:        string;
  timer:           ReturnType<typeof setTimeout>;
  envelope:        RelayToolCallEnvelope;
  connectionId:    string;
  connection:      DeviceConnection;
}

type BusMessage =
  | { kind: 'call'; envelope: RelayToolCallEnvelope }
  | { kind: 'result'; envelope: RelayToolResultEnvelope }
  | { kind: 'cancel'; requestId: string; deviceId: string };

/** Desktop enforces its fresh lease budget; relay retains the route for a late result receipt. */
const RESULT_GRACE_MS = 1_000;
const RESULT_RETENTION_MS = 10 * 60_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const MIN_DISPATCH_SAFETY_MS = 250;
const presenceKey = (deviceId: string) => `sulla:relay:device:${ deviceId }`;
const replicaChannel = (replicaId: string) => `sulla:relay:replica:${ replicaId }`;
const callKey = (deviceId: string, requestId: string) => `${ deviceId }\0${ requestId }`;
const REFRESH_PRESENCE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local current = cjson.decode(raw)
if current.connectionId ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

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
  readonly webSockets = new WebSocketServer({ noServer: true, maxPayload: RELAY_TUNNEL_WIRE_MAX_BYTES });
  private readonly redis:      Redis;
  private readonly subscriber: Redis;
  private readonly ledger: RelayRequestLedger;
  private readonly redisHealth: RedisHealthProbe;
  private readonly devices = new Map<string, DeviceConnection>();
  private readonly pendingHttp = new Map<string, PendingHttp>();
  private readonly localRoutes = new Map<string, LocalRoute>();

  constructor(private readonly config: RelayConfig) {
    this.redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    this.subscriber = this.redis.duplicate();
    this.ledger = new RelayRequestLedger(this.redis, RESULT_RETENTION_MS);
    // ioredis reconnects (and resubscribes) with backoff; /healthz reports the outage meanwhile.
    for (const [label, client] of [['command', this.redis], ['subscriber', this.subscriber]] as const) {
      client.on('error', (error: Error) => console.warn(`[sulla-relay] Redis ${ label } connection error; reconnecting:`, error.message));
    }
    this.redisHealth = new RedisHealthProbe(this.redis);
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
    const connections = [...this.devices.values()];
    for (const connection of connections) clearInterval(connection.heartbeat);
    // Remove local ownership before closing sockets so their asynchronous close
    // handlers cannot race Redis shutdown and attempt a second presence cleanup.
    this.devices.clear();
    let presenceCleanupError: unknown;
    await Promise.all(connections.map(async connection => {
      try {
        const current = await this.getPresence(connection.deviceId);
        if (current?.connectionId === connection.connectionId) await this.redis.del(presenceKey(connection.deviceId));
      } catch (error) {
        presenceCleanupError ??= error;
      } finally {
        connection.socket.close(1012, 'relay_shutdown');
      }
    }));
    for (const pending of this.pendingHttp.values()) clearTimeout(pending.timer);
    for (const route of this.localRoutes.values()) clearTimeout(route.timer);
    this.pendingHttp.clear();
    this.localRoutes.clear();
    this.webSockets.close();
    // Redis may already be closed (it is stopped alongside the relay); quit() then rejects
    // with "Connection is closed". Fall back to a hard disconnect so shutdown always completes.
    await Promise.all([this.redis, this.subscriber].map(async client => {
      try { await client.quit() } catch { client.disconnect() }
    }));
    // Continue closing service resources, then surface any presence failure.
    if (presenceCleanupError) throw presenceCleanupError;
  }

  async healthy(): Promise<boolean> {
    return await this.redisHealth.reachable();
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
      // 503 while Redis is unreachable so the container healthcheck (and Desktop) see it.
      if (await this.healthy()) sendJson(response, 200, { ok: true, replicaId: this.config.replicaId, devices: this.devices.size });
      else sendJson(response, 503, { ok: false, error: 'redis_unavailable' });
      return;
    }
    const resultMatch = /^\/v1\/devices\/([^/]+)\/tools\/results\/([^/]+)$/.exec(url.pathname);
    const toolMatch = /^\/v1\/devices\/([^/]+)\/tools\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!resultMatch && (request.method !== 'POST' || !toolMatch)) {
      sendJson(response, 404, { error: relayError('BAD_REQUEST', 'Route not found') }); return;
    }
    if (!tokenMatches(bearerToken(request.headers.authorization), this.config.internalToken)) {
      sendJson(response, 401, { error: relayError('FORBIDDEN', 'Invalid relay service token') }); return;
    }
    if (request.method === 'GET' && resultMatch) {
      const [deviceId, requestId] = resultMatch.slice(1).map(decodeURIComponent);
      const fingerprint = request.headers['x-sulla-request-fingerprint'];
      if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
        sendJson(response, 400, { error: relayError('BAD_REQUEST', 'A request fingerprint is required') }); return;
      }
      const record = await this.ledger.get(deviceId, requestId);
      if (!record) { sendJson(response, 404, { error: relayError('DEADLINE_EXCEEDED', 'No retained result exists for this request') }); return }
      if (record.fingerprint !== fingerprint) {
        sendJson(response, 409, { error: relayError('REQUEST_ID_REUSE', 'Request identity does not match the retained request') }); return;
      }
      if (record.result) this.sendResultResponse(response, record.result);
      else sendJson(response, 202, { error: relayError('REQUEST_IN_PROGRESS', 'The original request has no stored result yet', true) });
      return;
    }
    if (request.method !== 'POST' || !toolMatch) {
      sendJson(response, 404, { error: relayError('BAD_REQUEST', 'Route not found') }); return;
    }
    let body: Record<string, unknown>;
    try { body = await readJson(request) } catch (error) {
      sendJson(response, 400, { error: relayError('BAD_REQUEST', error instanceof Error ? error.message : String(error)) }); return;
    }
    const [deviceId, category, tool] = toolMatch.slice(1).map(decodeURIComponent);
    const ctx = body.ctx as RelayToolExecutionContext | undefined;
    const requestedDeadline = Number(body.deadlineMs);
    if (!ctx || typeof ctx.sub !== 'string' || typeof ctx.request_id !== 'string' || !ctx.request_id
      || ctx.request_id.length > 256 || !Number.isFinite(requestedDeadline) || requestedDeadline <= 0) {
      sendJson(response, 400, { error: relayError('BAD_REQUEST', 'ctx, request_id and a positive deadlineMs are required') }); return;
    }
    const presence = await this.getPresence(deviceId);
    if (!presence) { sendJson(response, 503, { error: relayError('DEVICE_OFFLINE', 'Desktop device is offline', true) }); return }
    if (ctx.sub !== presence.userId || (ctx.device_id && ctx.device_id !== deviceId)) {
      sendJson(response, 403, { error: relayError('FORBIDDEN', 'Tool context does not match the target Desktop') }); return;
    }
    const deadlineMs = Math.min(requestedDeadline, this.config.maxDeadlineMs);
    const requestId = ctx.request_id;
    const registration = await this.ledger.register({
      requestId, deviceId, userId: presence.userId, originReplicaId: this.config.replicaId, deadlineMs,
      identity: { ctx, category, tool, args: body.args },
    });
    if (registration.kind === 'conflict') {
      sendJson(response, 409, { error: relayError('REQUEST_ID_REUSE', 'request_id is already bound to a different user, context or tool payload') }); return;
    }
    if (registration.kind === 'existing') {
      if (registration.record.result) this.sendResultResponse(response, registration.record.result);
      else sendJson(response, 202, { error: relayError('REQUEST_IN_PROGRESS', 'The original request is still running; it will not be dispatched again', true) });
      return;
    }
    const requestFingerprint = registration.record.fingerprint;
    const envelope: RelayToolCallEnvelope = {
      type:            'tool-call',
      action:          'offer',
      requestId,
      deviceId,
      originReplicaId: this.config.replicaId,
      requestFingerprint,
      ctx,
      category,
      tool,
      args:            body.args,
      operationTypes:  Array.isArray(body.operationTypes) ? body.operationTypes.filter((type): type is string => typeof type === 'string') : [],
    };
    const startedAt = performance.now();
    const key = callKey(deviceId, requestId);
    const timer = setTimeout(() => {
      this.timeoutRequest(key).catch(error => console.error('[sulla-relay] Timeout cleanup failed:', error));
    }, deadlineMs + RESULT_GRACE_MS);
    this.pendingHttp.set(key, {
      response, ownerReplicaId: presence.replicaId, deviceId, timer, category, tool,
      operationTypes: envelope.operationTypes ?? [], startedAt, deadlineMs, fingerprint: requestFingerprint, requestId,
    });
    response.on('close', () => {
      if (!response.writableEnded && this.pendingHttp.has(key)) {
        this.cancelRequest(key).catch(error => console.error('[sulla-relay] Cancellation failed:', error));
      }
    });
    if (presence.replicaId === this.config.replicaId) {
      this.dispatchLocal(envelope).catch(error => console.error('[sulla-relay] Dispatch failed:', error));
    }
    else if (await this.publish(presence.replicaId, { kind: 'call', envelope }) === 0) {
      await this.completeBeforeDispatch(envelope, relayError('DEVICE_OFFLINE', 'Desktop relay replica is offline', true));
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
      heartbeatNonce: null,
      heartbeatSentAt: 0,
      lastHeartbeatRttMs: 0,
      heartbeatRtts: [],
      heartbeat: setInterval(() => this.pingDevice(connection), HEARTBEAT_INTERVAL_MS),
    };
    this.devices.set(claims.device_id, connection);
    await this.writePresence(connection);
    socket.on('pong', data => {
      this.onHeartbeatPong(connection, Buffer.from(data)).catch(error => console.error('[sulla-relay] Presence refresh failed:', error));
    });
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

  private pingDevice(connection: DeviceConnection): void {
    if (this.devices.get(connection.deviceId)?.connectionId !== connection.connectionId) return;
    if (connection.heartbeatNonce) {
      if (performance.now() - connection.heartbeatSentAt >= HEARTBEAT_TIMEOUT_MS) connection.socket.terminate();
      return;
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    connection.heartbeatNonce = nonce;
    connection.heartbeatSentAt = performance.now();
    connection.socket.ping(nonce, false, error => {
      if (error && this.devices.get(connection.deviceId)?.connectionId === connection.connectionId) {
        connection.socket.terminate();
      }
    });
  }

  private async onHeartbeatPong(connection: DeviceConnection, payload: Buffer): Promise<void> {
    if (this.devices.get(connection.deviceId)?.connectionId !== connection.connectionId) return;
    if (!connection.heartbeatNonce || payload.toString('utf8') !== connection.heartbeatNonce) return;
    const rtt = Math.max(0, performance.now() - connection.heartbeatSentAt);
    connection.heartbeatNonce = null;
    connection.heartbeatRtts.push(rtt);
    if (connection.heartbeatRtts.length > 3) connection.heartbeatRtts.shift();
    connection.lastHeartbeatRttMs = Math.max(...connection.heartbeatRtts);
    await this.refreshPresence(connection.deviceId, connection.connectionId);
  }

  private async writePresence(connection: DeviceConnection): Promise<void> {
    await this.redis.set(presenceKey(connection.deviceId), JSON.stringify({
      replicaId: this.config.replicaId, userId: connection.userId, connectionId: connection.connectionId,
    }), 'EX', this.config.presenceTtlSeconds);
  }

  private async refreshPresence(deviceId: string, connectionId: string): Promise<void> {
    const connection = this.devices.get(deviceId);
    if (connection?.connectionId !== connectionId) return;
    const refreshed = Number(await this.redis.eval(
      REFRESH_PRESENCE_SCRIPT, 1, presenceKey(deviceId), connectionId,
      JSON.stringify({ replicaId: this.config.replicaId, userId: connection.userId, connectionId }), String(this.config.presenceTtlSeconds),
    ));
    if (refreshed !== 1) {
      connection.socket.close(1008, 'superseded');
    }
  }

  private async removeDevice(connection: DeviceConnection): Promise<void> {
    clearInterval(connection.heartbeat);
    if (this.devices.get(connection.deviceId)?.connectionId !== connection.connectionId) return;
    this.devices.delete(connection.deviceId);
    const current = await this.getPresence(connection.deviceId);
    if (current?.connectionId === connection.connectionId) await this.redis.del(presenceKey(connection.deviceId));
  }

  private async getPresence(deviceId: string): Promise<{ replicaId: string; userId: string; connectionId: string } | null> {
    const raw = await this.redis.get(presenceKey(deviceId));
    if (!raw) return null;
    try { return JSON.parse(raw) } catch { return null }
  }

  private async dispatchLocal(envelope: RelayToolCallEnvelope): Promise<void> {
    const key = callKey(envelope.deviceId, envelope.requestId);
    if (this.localRoutes.has(key)) return;
    const remainingMs = await this.ledger.remainingMs(envelope.deviceId, envelope.requestId);
    if (remainingMs <= 0) {
      await this.completeBeforeDispatch(envelope, relayError('DEADLINE_EXCEEDED', 'Tool request lease expired before delivery', true));
      return;
    }
    const connection = this.devices.get(envelope.deviceId);
    if (connection?.socket.readyState !== WebSocket.OPEN) {
      await this.completeBeforeDispatch(envelope, relayError('DEVICE_OFFLINE', 'Desktop device is offline', true));
      return;
    }
    if (envelope.ctx?.sub !== connection.userId) {
      await this.completeBeforeDispatch(envelope, relayError('FORBIDDEN', 'Tool context does not match connected Desktop'));
      return;
    }
    if (connection.inflight.size >= this.config.maxInFlightPerDevice) {
      await this.completeBeforeDispatch(envelope, relayError('BACKPRESSURE', 'Desktop has reached its in-flight tool-call limit', true));
      return;
    }
    connection.inflight.add(key);
    const timer = setTimeout(() => {
      this.expireLocalRoute(key).catch(error => console.error('[sulla-relay] Route expiry failed:', error));
    }, remainingMs + RESULT_GRACE_MS + RESULT_RETENTION_MS);
    const route: LocalRoute = {
      originReplicaId: envelope.originReplicaId!, deviceId: envelope.deviceId, timer,
      envelope, connectionId: connection.connectionId, connection,
    };
    this.localRoutes.set(key, route);
    try {
      this.sendToDevice(connection, { ...envelope, action: 'offer', remainingMs });
    } catch (error) {
      clearTimeout(timer);
      this.localRoutes.delete(key);
      connection.inflight.delete(key);
      await this.completeBeforeDispatch(envelope, relayError('DEVICE_OFFLINE', 'Desktop tunnel closed before the request was delivered', true));
    }
  }

  private async claimLocal(connection: DeviceConnection, claim: Extract<RelayEnvelope, { type: 'tool-call-claim' }>): Promise<void> {
    if (claim.deviceId !== connection.deviceId) return;
    const key = callKey(claim.deviceId, claim.requestId);
    const route = this.localRoutes.get(key);
    if (!route || route.envelope.requestFingerprint !== claim.requestFingerprint || route.envelope.ctx?.sub !== connection.userId) return;
    const safetyMs = Math.max(MIN_DISPATCH_SAFETY_MS, Math.ceil(connection.lastHeartbeatRttMs));
    const grant = await this.ledger.grantExecution(claim.deviceId, claim.requestId, claim.requestFingerprint, safetyMs);
    if (grant.kind === 'expired') {
      await this.completeBeforeDispatch(route.envelope, relayError('DEADLINE_EXCEEDED', 'Tool request lease expired before execution was authorized', true));
      this.removeLocalRoute(key, route);
      this.sendToDevice(connection, { type: 'tool-call', action: 'cancel', requestId: claim.requestId, deviceId: claim.deviceId });
      return;
    }
    if (grant.kind !== 'granted') return;
    if (route.connection !== connection) {
      route.connection.inflight.delete(key);
      connection.inflight.add(key);
      route.connection = connection;
      route.connectionId = connection.connectionId;
    }
    this.sendToDevice(connection, { ...route.envelope, action: 'execute', remainingMs: grant.remainingMs });
  }

  private async expireLocalRoute(key: string): Promise<void> {
    const route = this.localRoutes.get(key);
    if (!route) return;
    const record = await this.ledger.get(route.deviceId, route.envelope.requestId);
    if (!record?.executionGranted && !record?.result) {
      await this.completeBeforeDispatch(route.envelope, relayError('DEADLINE_EXCEEDED', 'Tool request lease expired before execution was authorized', true));
    }
    this.removeLocalRoute(key, route);
    if (route.connection.socket.readyState === WebSocket.OPEN) {
      this.sendToDevice(route.connection, { type: 'tool-call', action: 'cancel', requestId: route.envelope.requestId, deviceId: route.deviceId });
    }
  }

  private removeLocalRoute(key: string, route: LocalRoute): void {
    if (this.localRoutes.get(key) !== route) return;
    clearTimeout(route.timer);
    this.localRoutes.delete(key);
    route.connection.inflight.delete(key);
  }

  private async completeBeforeDispatch(envelope: RelayToolCallEnvelope, error: RelayError): Promise<void> {
    const result: RelayToolResultEnvelope = {
      type: 'tool-result', requestId: envelope.requestId, deviceId: envelope.deviceId,
      requestFingerprint: envelope.requestFingerprint, resultRevision: 1, error,
    };
    const write = await this.ledger.storeResult(result);
    if (write === 'missing' || write === 'fingerprint-mismatch' || write === 'conflict') return;
    const record = await this.ledger.get(envelope.deviceId, envelope.requestId);
    if (record?.result) await this.routeResult(record.originReplicaId, record.result);
  }

  private async onDeviceMessage(connection: DeviceConnection, raw: string): Promise<void> {
    let envelope: RelayEnvelope;
    try { envelope = JSON.parse(raw) as RelayEnvelope } catch { return }
    if (envelope.type === 'tool-call-claim') {
      await this.claimLocal(connection, envelope);
      return;
    }
    if (envelope.type !== 'tool-result' || envelope.deviceId !== connection.deviceId || !envelope.requestFingerprint) return;
    const record = await this.ledger.get(envelope.deviceId, envelope.requestId);
    if (!record || record.userId !== connection.userId) return;
    const bounded = this.boundResult(envelope);
    const write = await this.ledger.storeResult(bounded);
    if (write === 'missing' || write === 'fingerprint-mismatch' || write === 'conflict') return;
    const saved = await this.ledger.get(envelope.deviceId, envelope.requestId);
    if (!saved?.result || !saved.fingerprint) return;
    this.sendToDevice(connection, {
      type: 'tool-result-ack', requestId: envelope.requestId, deviceId: envelope.deviceId,
      requestFingerprint: saved.fingerprint, resultRevision: saved.result.resultRevision ?? 1,
    });
    const key = callKey(envelope.deviceId, envelope.requestId);
    const route = this.localRoutes.get(key);
    if (route && !saved.result.provisional) this.removeLocalRoute(key, route);
    await this.routeResult(saved.originReplicaId, saved.result);
  }

  private boundResult(envelope: RelayToolResultEnvelope): RelayToolResultEnvelope {
    if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= RELAY_TOOL_RESULT_MAX_BYTES) return envelope;
    return {
      type: 'tool-result', requestId: envelope.requestId, deviceId: envelope.deviceId,
      requestFingerprint: envelope.requestFingerprint, resultRevision: envelope.resultRevision,
      ...(envelope.provisional ? { provisional: true } : {}), ...(envelope.late ? { late: true } : {}),
      error: relayError('RESULT_TOO_LARGE', `Tool result exceeds the ${ RELAY_TOOL_RESULT_MAX_BYTES} byte per-result limit`),
    };
  }

  private async routeResult(originReplicaId: string, envelope: RelayToolResultEnvelope): Promise<void> {
    if (originReplicaId === this.config.replicaId) this.finishHttp(envelope);
    else await this.publish(originReplicaId, { kind: 'result', envelope });
  }

  private sendResultResponse(response: ServerResponse, envelope: RelayToolResultEnvelope): void {
    const status = envelope.error?.code === 'FORBIDDEN'
      ? 403
      : envelope.error?.code === 'DEVICE_OFFLINE'
        ? 503
        : envelope.error?.code === 'BACKPRESSURE'
          ? 429
          : envelope.error?.code === 'DEADLINE_EXCEEDED' ? 504
            : envelope.error?.code === 'REQUEST_IN_PROGRESS' ? 202
              : envelope.error?.code === 'RESULT_TOO_LARGE' ? 413
                : envelope.error ? 500 : 200;
    sendJson(response, status, envelope.error ? { error: envelope.error } : { result: envelope.result });
  }

  private finishHttp(envelope: RelayToolResultEnvelope): void {
    const pending = this.pendingHttp.get(callKey(envelope.deviceId, envelope.requestId));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingHttp.delete(callKey(envelope.deviceId, envelope.requestId));
    this.sendResultResponse(pending.response, envelope);
  }

  private async timeoutRequest(key: string): Promise<void> {
    const pending = this.pendingHttp.get(key);
    if (!pending) return;
    this.pendingHttp.delete(key);
    const elapsedMs = Math.max(0, Math.round(performance.now() - pending.startedAt));
    const details = new ToolDeadlinePolicy().timeoutDetails(
      `${ pending.category }/${ pending.tool }`, pending.deadlineMs, elapsedMs, pending.operationTypes);
    sendJson(pending.response, 504, { error: { ...relayError('DEADLINE_EXCEEDED', 'Desktop tool call deadline exceeded', true), details } });
    // Do not cancel here: the result may still arrive after an interrupted/ambiguous write.
    // The Desktop owns its deadline abort, and the relay keeps the request route for retrieval.
  }

  private async cancelRequest(key: string): Promise<void> {
    const pending = this.pendingHttp.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingHttp.delete(key);
    await this.publishOrCancelLocal(pending.ownerReplicaId, pending.requestId, pending.deviceId);
  }

  private async publishOrCancelLocal(ownerReplicaId: string, requestId: string, deviceId: string): Promise<void> {
    if (ownerReplicaId === this.config.replicaId) this.cancelLocal(requestId, deviceId);
    else await this.publish(ownerReplicaId, { kind: 'cancel', requestId, deviceId });
  }

  private cancelLocal(requestId: string, deviceId: string): void {
    const key = callKey(deviceId, requestId);
    const route = this.localRoutes.get(key);
    if (route) this.removeLocalRoute(key, route);
    const connection = this.devices.get(deviceId);
    if (connection) this.sendToDevice(connection, { type: 'tool-call', action: 'cancel', requestId, deviceId });
  }

  private sendToDevice(connection: DeviceConnection, envelope: RelayEnvelope): void {
    if (connection.socket.readyState !== WebSocket.OPEN) throw new Error('Desktop relay socket is not open');
    connection.socket.send(JSON.stringify(envelope));
  }

  private async publish(replicaId: string, message: BusMessage): Promise<number> {
    return await this.redis.publish(replicaChannel(replicaId), JSON.stringify(message));
  }

  private async onBusMessage(raw: string): Promise<void> {
    let message: BusMessage;
    try { message = JSON.parse(raw) as BusMessage } catch { return }
    if (message.kind === 'call') await this.dispatchLocal(message.envelope);
    else if (message.kind === 'result') this.finishHttp(message.envelope);
    else this.cancelLocal(message.requestId, message.deviceId);
  }
}
