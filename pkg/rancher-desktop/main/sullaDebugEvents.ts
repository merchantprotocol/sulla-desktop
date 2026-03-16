/**
 * Debug & monitoring IPC event handlers.
 * Exposes heartbeat status/history, conversation logs, system health,
 * and error aggregation to the MonitorDashboard frontend.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';

import { getIpcMainProxy } from '@pkg/main/ipcMain';
import Logging from '@pkg/utils/logging';

const console = Logging.background;
const ipcMainProxy = getIpcMainProxy(console);

// ── Helpers ──

function httpProbe(port: number, pathname = '/'): Promise<{ ok: boolean; statusCode?: number; body?: string; error?: string }> {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: pathname, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString() });
      res.on('end', () => resolve({ ok: res.statusCode === 200, statusCode: res.statusCode, body }));
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }) });
  });
}

function tcpProbe(port: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(3000);
    socket.on('connect', () => { socket.destroy(); resolve({ ok: true }) });
    socket.on('error', (err) => resolve({ ok: false, error: err.message }));
    socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, error: 'timeout' }) });
    socket.connect(port, '127.0.0.1');
  });
}

function readJsonlFile(filePath: string, maxLines = 500): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  // Take the last maxLines
  const recent = lines.slice(-maxLines);
  const results: unknown[] = [];
  for (const line of recent) {
    try {
      results.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return results;
}

export function initSullaDebugEvents(): void {
  // ─────────────────────────────────────────────────────────────
  // Heartbeat status & history
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('debug-heartbeat-status', async() => {
    try {
      const { getHeartbeatService } = await import('@pkg/agent/services/HeartbeatService');
      const svc = getHeartbeatService();
      return svc.getStatus();
    } catch {
      return {
        initialized:      false,
        isExecuting:      false,
        lastTriggerMs:    0,
        schedulerRunning: false,
        totalTriggers:    0,
        totalErrors:      0,
        totalSkips:       0,
        uptimeMs:         0,
      };
    }
  });

  ipcMainProxy.handle('debug-heartbeat-schedule', async() => {
    try {
      const { SullaSettingsModel } = await import('@pkg/agent/database/models/SullaSettingsModel');
      const { getHeartbeatService } = await import('@pkg/agent/services/HeartbeatService');
      const status = getHeartbeatService().getStatus();
      const enabled = await SullaSettingsModel.get('heartbeatEnabled', false);
      const delayMinutes = Math.max(1, await SullaSettingsModel.get('heartbeatDelayMinutes', 30));
      const delayMs = delayMinutes * 60_000;
      const nextTriggerMs = status.lastTriggerMs > 0 ? status.lastTriggerMs + delayMs : Date.now();

      return { enabled, delayMinutes, nextTriggerMs };
    } catch {
      return { enabled: false, delayMinutes: 30, nextTriggerMs: 0 };
    }
  });

  ipcMainProxy.handle('debug-heartbeat-history', async(_event: unknown, limit?: number) => {
    try {
      const { getHeartbeatService } = await import('@pkg/agent/services/HeartbeatService');
      const svc = getHeartbeatService();
      return svc.getHistory(limit ?? 50);
    } catch (err) {
      return [];
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Conversation log browser
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('debug-conversations-list', async() => {
    try {
      const { resolveSullaLogsDir } = await import('@pkg/agent/utils/sullaPaths');
      const dir = resolveSullaLogsDir();
      const indexPath = path.join(dir, 'index.jsonl');
      const entries = readJsonlFile(indexPath, 1000) as any[];

      // Deduplicate by id — last entry wins (updates overwrite)
      const byId = new Map<string, any>();
      for (const entry of entries) {
        if (!entry.id) continue;
        if (entry._update) {
          const existing = byId.get(entry.id);
          if (existing) {
            byId.set(entry.id, { ...existing, ...entry });
          }
        } else {
          byId.set(entry.id, entry);
        }
      }

      // Return most recent first
      return Array.from(byId.values()).reverse().slice(0, 200);
    } catch (err) {
      return [];
    }
  });

  ipcMainProxy.handle('debug-conversation-events', async(_event: unknown, conversationId: string) => {
    try {
      const { resolveSullaLogsDir } = await import('@pkg/agent/utils/sullaPaths');
      const dir = resolveSullaLogsDir();
      const safe = conversationId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
      const filePath = path.join(dir, `conv_${ safe }.jsonl`);
      return readJsonlFile(filePath, 500) as { ts: string; type: string; [key: string]: unknown }[];
    } catch {
      return [];
    }
  });

  // ─────────────────────────────────────────────────────────────
  // System health checks
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('debug-health-check', async() => {
    const [chatApi, terminal, dashboard, wsHub] = await Promise.all([
      httpProbe(3000, '/health'),
      tcpProbe(6108),
      httpProbe(6120),
      tcpProbe(30118),
    ]);

    // Redis check
    let redis = { ok: false, error: 'not checked' };
    try {
      const { redisClient } = await import('@pkg/agent/database/RedisClient');
      const client = redisClient as any;
      const pong = typeof client.ping === 'function' ? await client.ping() : 'unavailable';
      redis = { ok: pong === 'PONG', error: pong !== 'PONG' ? `unexpected: ${ pong }` : undefined } as any;
    } catch (err) {
      redis = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Heartbeat service check
    let heartbeat = { ok: false, error: 'not checked' };
    try {
      const { getHeartbeatService } = await import('@pkg/agent/services/HeartbeatService');
      const status = getHeartbeatService().getStatus();
      heartbeat = { ok: status.initialized && status.schedulerRunning, error: !status.initialized ? 'not initialized' : undefined } as any;
    } catch (err) {
      heartbeat = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    return {
      chatApi:   { name: 'Chat API', port: 3000, ...chatApi },
      terminal:  { name: 'Terminal Server', port: 6108, ...terminal },
      dashboard: { name: 'Dashboard', port: 6120, ...dashboard },
      wsHub:     { name: 'WebSocket Hub', port: 30118, ...wsHub },
      redis:     { name: 'Redis', ...redis },
      heartbeat: { name: 'Heartbeat Service', ...heartbeat },
    };
  });

  // ─────────────────────────────────────────────────────────────
  // Active agents (from Redis)
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('debug-active-agents', async() => {
    try {
      const { getActiveAgentsRegistry } = await import('@pkg/agent/services/ActiveAgentsRegistry');
      const registry = getActiveAgentsRegistry();
      return await registry.getAllAgents();
    } catch (err) {
      return [];
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Error aggregation from conversation logs
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('debug-errors', async(_event: unknown, limit?: number) => {
    try {
      const { resolveSullaLogsDir } = await import('@pkg/agent/utils/sullaPaths');
      const dir = resolveSullaLogsDir();
      const indexPath = path.join(dir, 'index.jsonl');
      const entries = readJsonlFile(indexPath, 1000) as any[];

      // Find conversations with errors
      const errors: any[] = [];
      for (const entry of entries) {
        if (entry.error || entry.status === 'error' || entry.status === 'failed') {
          errors.push({
            conversationId: entry.id,
            type:           entry.type,
            name:           entry.name,
            startedAt:      entry.startedAt,
            completedAt:    entry.completedAt,
            error:          entry.error || entry.status,
            channel:        entry.channel,
          });
        }
      }

      // Also scan recent conversation files for tool_call errors
      const convFiles = fs.readdirSync(dir).filter(f => f.startsWith('conv_') && f.endsWith('.jsonl'));
      // Only scan last 20 files to keep it fast
      const recentFiles = convFiles.slice(-20);
      for (const file of recentFiles) {
        const events = readJsonlFile(path.join(dir, file), 200) as any[];
        for (const evt of events) {
          if (evt.type === 'tool_call' && evt.result && typeof evt.result === 'object' && (evt.result).error) {
            errors.push({
              conversationId: file.replace('conv-', '').replace('.jsonl', ''),
              type:           'tool_error',
              name:           evt.toolName,
              startedAt:      evt.ts,
              error:          (evt.result).error,
            });
          }
        }
      }

      // Sort by time descending, limit
      errors.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
      return errors.slice(0, limit ?? 100);
    } catch (err) {
      return [];
    }
  });

  // ─────────────────────────────────────────────────────────────
  // WebSocket connection stats
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('debug-ws-stats', async() => {
    type WsStats = Record<string, { connected: boolean; reconnectAttempts: number; pendingMessages: number; subscribedChannels: string[] }>;
    try {
      const { getWebSocketClientService } = await import('@pkg/agent/services/WebSocketClientService');
      const ws = getWebSocketClientService();
      return (ws.getConnectionStats?.() || {}) as WsStats;
    } catch {
      return {} as WsStats;
    }
  });

  // ─────────────────────────────────────────────────────────────
  // WebSocket message tap (enable/disable + fetch recent messages)
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('debug-ws-tap', async(_event: unknown, enabled: boolean) => {
    try {
      const { getWebSocketClientService } = await import('@pkg/agent/services/WebSocketClientService');
      getWebSocketClientService().setTapping(enabled);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMainProxy.handle('debug-ws-messages', async(_event: unknown, connectionId?: string, limit?: number) => {
    try {
      const { getWebSocketClientService } = await import('@pkg/agent/services/WebSocketClientService');
      return getWebSocketClientService().getRecentMessages(connectionId || undefined, limit ?? 100);
    } catch {
      return [];
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Service detail logs (heartbeat events, conversation events for agents)
  // ─────────────────────────────────────────────────────────────

  ipcMainProxy.handle('debug-service-detail', async(_event: unknown, serviceKey: string) => {
    try {
      switch (serviceKey) {
      case 'heartbeat': {
        const { getHeartbeatService } = await import('@pkg/agent/services/HeartbeatService');
        const svc = getHeartbeatService();
        return { type: 'heartbeat', status: svc.getStatus(), events: svc.getHistory(200) };
      }
      case 'redis': {
        const { redisClient } = await import('@pkg/agent/database/RedisClient');
        const client = redisClient as any;
        const info = typeof client.info === 'function' ? await client.info('server') : 'unavailable';
        return { type: 'redis', info: typeof info === 'string' ? info.slice(0, 2000) : String(info) };
      }
      default: {
        // For port-based services, just return the probe result
        const ports: Record<string, number> = { chatApi: 3000, terminal: 6108, dashboard: 6120, wsHub: 30118 };
        const port = ports[serviceKey];
        if (port) {
          const probe = serviceKey === 'terminal' || serviceKey === 'wsHub'
            ? await tcpProbe(port)
            : await httpProbe(port, '/health');
          return { type: 'probe', port, ...probe };
        }
        return { type: 'unknown' };
      }
      }
    } catch (err) {
      return { type: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Live conversation stream (push events to renderer via IPC)
  // ─────────────────────────────────────────────────────────────

  let liveConvListener: ((...args: any[]) => void) | null = null;
  let liveEventListener: ((...args: any[]) => void) | null = null;

  ipcMainProxy.handle('debug-live-start', async(event: any) => {
    try {
      const { getConversationLogger } = await import('@pkg/agent/services/ConversationLogger');
      const logger = getConversationLogger();
      const sender = event.sender;

      // Clean up any existing listeners
      if (liveConvListener) logger.removeListener('conversation', liveConvListener);
      if (liveEventListener) logger.removeListener('event', liveEventListener);

      liveConvListener = (data: any) => {
        try {
          if (!sender.isDestroyed()) {
            sender.send('debug-live-conversation', data);
          }
        } catch { /* renderer gone */ }
      };

      liveEventListener = (data: any) => {
        try {
          if (!sender.isDestroyed()) {
            sender.send('debug-live-event', data);
          }
        } catch { /* renderer gone */ }
      };

      logger.on('conversation', liveConvListener);
      logger.on('event', liveEventListener);

      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMainProxy.handle('debug-live-stop', async() => {
    try {
      const { getConversationLogger } = await import('@pkg/agent/services/ConversationLogger');
      const logger = getConversationLogger();
      if (liveConvListener) {
        logger.removeListener('conversation', liveConvListener);
        liveConvListener = null;
      }
      if (liveEventListener) {
        logger.removeListener('event', liveEventListener);
        liveEventListener = null;
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  console.log('[SullaDebugEvents] Debug IPC handlers registered');
}
