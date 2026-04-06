/**
 * Service — gateway connection manager.
 *
 * Manages the lobby WebSocket to the transcription gateway, session
 * creation/teardown via REST, and the per-session audio streaming
 * WebSocket. Matches the protocol used by Sulla Desktop.
 *
 * Lifecycle:
 *   connectLobby()   → persistent WebSocket for health + announcements
 *   startSession()   → REST creates session, opens audio + listener WSes
 *   sendAudio()      → binary frames to audio WebSocket
 *   stopSession()    → closes WSes, REST deletes session
 *   disconnectLobby()→ tears down lobby
 */

import { net, app } from 'electron';
import * as os from 'os';
import * as auth from '../model/auth';
import { log } from '../model/logger';
import { GATEWAY_URL as DEFAULT_GATEWAY_URL, IS_LOCAL } from '../config';

// Use __non_webpack_require__ to bypass webpack bundling for the ws package.
declare const __non_webpack_require__: typeof require;
const WebSocket = __non_webpack_require__('ws');

const TAG = 'Gateway';

// ─── State ──────────────────────────────────────────────────────

let lobbyWs: InstanceType<typeof WebSocket> | null = null;
let audioWs: InstanceType<typeof WebSocket> | null = null;
let listenerWs: InstanceType<typeof WebSocket> | null = null;

let sessionId: string | null = null;
let callId: string | null = null;

let lobbyReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lobbyReconnectAttempt = 0;
const LOBBY_MAX_RECONNECT = 20;
const LOBBY_BASE_DELAY = 5000;
const LOBBY_MAX_DELAY = 60000;

let audioReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let audioReconnectAttempt = 0;
const AUDIO_MAX_RECONNECT = 5;
const AUDIO_RECONNECT_DELAY = 2000;

let listenerReconnectAttempt = 0;
const LISTENER_MAX_RECONNECT = 10;
const LISTENER_RECONNECT_DELAY = 2000;

let healthPingTimer: ReturnType<typeof setTimeout> | null = null;
const HEALTH_PING_TIMEOUT = 45000;

const BACKPRESSURE_LIMIT = 64 * 1024;  // 64 KB

// Callbacks
let onTranscript: ((msg: any) => void) | null = null;
let onStatusChange: ((status: any) => void) | null = null;

// ─── Config ─────────────────────────────────────────────────────

function _gatewayUrl(): string {
  const gw = auth.getGateway();
  return gw.url || DEFAULT_GATEWAY_URL;
}

function _apiKey(): string | null {
  const gw = auth.getGateway();
  return gw.apiKey || null;
}

function _wsUrl(path: string): string {
  const base = _gatewayUrl().replace(/^http/, 'ws');
  return base + path;
}

function _headers(): Record<string, string> {
  const key = _apiKey();
  return key ? { Authorization: 'Bearer ' + key } : {};
}

function _wsOpts(): Record<string, any> {
  const opts: Record<string, any> = { headers: _headers() };
  if (IS_LOCAL) opts.rejectUnauthorized = false;
  return opts;
}

// ─── Lobby WebSocket ────────────────────────────────────────────

export function connectLobby(): void {
  if (lobbyWs) return;

  const version = app.getVersion();
  const hostname = os.hostname();
  const url = _wsUrl(`/ws/listener?appName=AudioDriver&appVersion=${version}&hostname=${encodeURIComponent(hostname)}`);

  log.info(TAG, 'Connecting lobby', { url });

  try {
    lobbyWs = new WebSocket(url, _wsOpts());
  } catch (e: any) {
    log.error(TAG, 'Lobby connect error', { error: e.message });
    _scheduleLobbyReconnect();
    return;
  }

  lobbyWs.on('open', () => {
    log.info(TAG, 'Lobby connected');
    lobbyReconnectAttempt = 0;
    _fireStatus();

    // Send capabilities handshake
    _lobbySend({ event_type: 'capabilities', reliable_delivery: true });

    // Start health monitoring
    _resetHealthPing();
  });

  lobbyWs.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());

      // ACK reliable delivery
      if (msg._msg_id) {
        _lobbySend({ event_type: 'ack', _msg_id: msg._msg_id });
      }

      if (msg.event_type === 'health_ping') {
        _resetHealthPing();
      } else if (msg.event_type === 'transcript_turn' || msg.event_type === 'transcript_partial') {
        if (onTranscript) onTranscript(msg);
      }

      log.debug(TAG, 'Lobby message', { type: msg.event_type });
    } catch (e: any) {
      log.warn(TAG, 'Lobby message parse error', { error: e.message });
    }
  });

  lobbyWs.on('close', (code: number, reason: Buffer) => {
    log.info(TAG, 'Lobby closed', { code, reason: reason?.toString() });
    lobbyWs = null;
    _clearHealthPing();
    _fireStatus();
    _scheduleLobbyReconnect();
  });

  lobbyWs.on('error', (err: Error) => {
    log.error(TAG, 'Lobby error', { error: err.message });
  });
}

export function disconnectLobby(): void {
  _clearLobbyReconnect();
  _clearHealthPing();
  if (lobbyWs) {
    lobbyWs.close();
    lobbyWs = null;
  }
  _fireStatus();
}

function _lobbySend(obj: Record<string, any>): void {
  if (lobbyWs && lobbyWs.readyState === WebSocket.OPEN) {
    lobbyWs.send(JSON.stringify(obj));
  }
}

function _scheduleLobbyReconnect(): void {
  _clearLobbyReconnect();
  if (lobbyReconnectAttempt >= LOBBY_MAX_RECONNECT) {
    log.error(TAG, 'Lobby max reconnect attempts reached');
    return;
  }
  const delay = Math.min(LOBBY_BASE_DELAY * Math.pow(1.5, lobbyReconnectAttempt), LOBBY_MAX_DELAY);
  lobbyReconnectAttempt++;
  log.info(TAG, 'Lobby reconnecting', { attempt: lobbyReconnectAttempt, delay });
  lobbyReconnectTimer = setTimeout(() => connectLobby(), delay);
}

function _clearLobbyReconnect(): void {
  if (lobbyReconnectTimer) {
    clearTimeout(lobbyReconnectTimer);
    lobbyReconnectTimer = null;
  }
}

function _resetHealthPing(): void {
  _clearHealthPing();
  healthPingTimer = setTimeout(() => {
    log.warn(TAG, 'Health ping timeout — reconnecting lobby');
    if (lobbyWs) lobbyWs.close();
  }, HEALTH_PING_TIMEOUT);
}

function _clearHealthPing(): void {
  if (healthPingTimer) {
    clearTimeout(healthPingTimer);
    healthPingTimer = null;
  }
}

// ─── Session REST ───────────────────────────────────────────────

/**
 * Create a new streaming session.
 */
export async function startSession(opts: {
  callerName?: string;
  channels?: Record<string, any>;
} = {}): Promise<{ sessionId: string; callId: string }> {
  const url = _gatewayUrl() + '/api/desktop/sessions';
  const user = auth.getSession().user;
  const body = {
    userId:     user?.id || undefined,
    callerName: opts.callerName || 'Audio Driver',
    mode:       'listen-only-meeting',
    channels:   opts.channels || {
      '0': { label: 'User', source: 'mic' },
      '1': {
        label:       'Caller',
        source:      'system_audio',
        audioFormat: { inputFormat: 's16le', inputRate: 16000, inputChannels: 1 },
      },
    },
  };

  log.info(TAG, 'Creating session', { url });

  const result = await _restPost(url, body);
  sessionId = result.sessionId;
  callId = result.callId;

  log.info(TAG, 'Session created', { sessionId, callId });

  // Open audio WebSocket
  _connectAudioWs();

  // Open session listener
  _connectListenerWs();

  _fireStatus();
  return { sessionId: sessionId!, callId: callId! };
}

/**
 * End the current session.
 */
export async function stopSession(): Promise<void> {
  const sid = sessionId;
  if (!sid) return; // Already stopped or never started

  // Clear sessionId immediately to prevent duplicate stops
  sessionId = null;

  // Close WebSockets first (stops audio flow)
  _clearAudioReconnect();
  if (audioWs) { audioWs.close(); audioWs = null; }
  if (listenerWs) { listenerWs.close(); listenerWs = null; }

  // REST delete while sessionId is still set (prevents race with sendAudio)
  if (sid) {
    try {
      await _restDelete(_gatewayUrl() + '/api/desktop/sessions/' + sid);
      log.info(TAG, 'Session deleted', { sessionId: sid });
    } catch (e: any) {
      log.warn(TAG, 'Session delete failed', { error: e.message });
    }
  }

  // Clear remaining state after sockets closed and REST complete
  callId = null;
  audioChunkCount = 0;
  micFirstChunkSent = false;
  speakerBuffer = [];
  listenerReconnectAttempt = 0;

  _fireStatus();
}

// ─── Audio WebSocket ────────────────────────────────────────────

function _connectAudioWs(): void {
  if (!sessionId) return;

  const url = _wsUrl('/ws/audio/' + sessionId);
  log.info(TAG, 'Connecting audio stream', { url });

  try {
    audioWs = new WebSocket(url, _wsOpts());
  } catch (e: any) {
    log.error(TAG, 'Audio WS connect error', { error: e.message });
    _scheduleAudioReconnect();
    return;
  }

  audioWs.on('open', () => {
    log.info(TAG, 'Audio stream connected');
    audioReconnectAttempt = 0;
    _fireStatus();
  });

  audioWs.on('close', (code: number) => {
    log.info(TAG, 'Audio stream closed', { code });
    audioWs = null;
    // Reset mic-first ordering so the next WebM header is sent before speaker PCM
    micFirstChunkSent = false;
    speakerBuffer = [];
    _fireStatus();
    if (sessionId) _scheduleAudioReconnect();
  });

  audioWs.on('error', (err: Error) => {
    log.error(TAG, 'Audio stream error', { error: err.message });
  });
}

function _scheduleAudioReconnect(): void {
  _clearAudioReconnect();
  if (audioReconnectAttempt >= AUDIO_MAX_RECONNECT) {
    log.error(TAG, 'Audio stream max reconnect reached');
    return;
  }
  audioReconnectAttempt++;
  log.info(TAG, 'Audio stream reconnecting', { attempt: audioReconnectAttempt });
  audioReconnectTimer = setTimeout(() => _connectAudioWs(), AUDIO_RECONNECT_DELAY);
}

function _clearAudioReconnect(): void {
  if (audioReconnectTimer) {
    clearTimeout(audioReconnectTimer);
    audioReconnectTimer = null;
  }
}

/**
 * Send an audio chunk to the gateway.
 */
let audioChunkCount = 0;
let micFirstChunkSent = false;
let speakerBuffer: Buffer[] = [];        // Buffer speaker chunks until first mic chunk sent
const MAX_SPEAKER_BUFFER = 100; // Don't buffer more than ~2.5s of speaker audio

export function sendAudio(audioData: any, channel: number): void {
  if (!audioWs || audioWs.readyState !== WebSocket.OPEN) return;

  // Backpressure check
  if (audioWs.bufferedAmount > BACKPRESSURE_LIMIT) return;

  // Ensure mic (channel 0) is sent first so the gateway's AudioConverter
  // auto-detects WebM/Opus correctly before raw PCM arrives on channel 1.
  if (channel !== 0 && !micFirstChunkSent) {
    if (speakerBuffer.length < MAX_SPEAKER_BUFFER) {
      speakerBuffer.push(Buffer.from(audioData));
    }
    return;
  }

  if (channel === 0 && !micFirstChunkSent) {
    micFirstChunkSent = true;
    // Send the mic chunk first
    audioWs.send(audioData);
    // Flush buffered speaker chunks
    for (const buf of speakerBuffer) {
      const header = Buffer.alloc(2);
      header[0] = 0x01;
      header[1] = 1;
      audioWs.send(Buffer.concat([header, buf]));
    }
    speakerBuffer = [];
  } else if (channel === 0) {
    // Channel 0: send raw bytes (WebM/Opus for mic)
    audioWs.send(audioData);
  } else {
    // Channel > 0: prefix with [0x01][channel_id]
    const header = Buffer.alloc(2);
    header[0] = 0x01;
    header[1] = channel;
    const payload = Buffer.concat([header, Buffer.from(audioData)]);
    audioWs.send(payload);
  }

  // Log first 3 chunks per channel, then every 100th
  audioChunkCount++;
  if (audioChunkCount <= 3 || audioChunkCount % 100 === 0) {
    log.debug(TAG, 'Audio chunk sent', {
      channel,
      bytes: (audioData as any).byteLength || (audioData as any).length,
      total: audioChunkCount,
      buffered: audioWs.bufferedAmount,
    });
  }
}

// ─── Session Listener WebSocket ─────────────────────────────────

function _connectListenerWs(): void {
  if (!sessionId) return;

  const apiKey = encodeURIComponent(_apiKey() || '');
  const url = _wsUrl('/ws/listener/' + sessionId + '?apiKey=' + apiKey);
  log.info(TAG, 'Connecting session listener', { sessionId });

  try {
    listenerWs = new WebSocket(url, _wsOpts());
  } catch (e: any) {
    log.error(TAG, 'Listener WS connect error', { error: e.message });
    return;
  }

  listenerWs.on('open', () => {
    log.info(TAG, 'Session listener connected');
    listenerReconnectAttempt = 0;
  });

  listenerWs.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());

      // ACK reliable delivery
      if (msg._msg_id && listenerWs && listenerWs.readyState === WebSocket.OPEN) {
        listenerWs.send(JSON.stringify({ event_type: 'ack', _msg_id: msg._msg_id }));
      }

      if (msg.event_type === 'transcript_turn' || msg.event_type === 'transcript_partial') {
        if (onTranscript) onTranscript(msg);
      }

      log.debug(TAG, 'Listener message', { type: msg.event_type });
    } catch (e: any) {
      log.warn(TAG, 'Listener parse error', { error: e.message });
    }
  });

  listenerWs.on('close', () => {
    log.info(TAG, 'Session listener closed');
    listenerWs = null;
    // Auto-reconnect if session still active (with attempt cap)
    if (sessionId && listenerReconnectAttempt < LISTENER_MAX_RECONNECT) {
      listenerReconnectAttempt++;
      log.info(TAG, 'Listener reconnecting', { attempt: listenerReconnectAttempt });
      setTimeout(() => _connectListenerWs(), LISTENER_RECONNECT_DELAY);
    } else if (listenerReconnectAttempt >= LISTENER_MAX_RECONNECT) {
      log.error(TAG, 'Listener max reconnect attempts reached');
    }
  });

  listenerWs.on('error', (err: Error) => {
    log.error(TAG, 'Listener error', { error: err.message });
  });
}

// ─── REST helpers ───────────────────────────────────────────────

function _restPost(url: string, body: Record<string, any>): Promise<any> {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'POST', url });
    request.setHeader('Content-Type', 'application/json');
    request.setHeader('Accept', 'application/json');
    const key = _apiKey();
    if (key) request.setHeader('Authorization', 'Bearer ' + key);

    let responseData = '';

    request.on('response', (response) => {
      response.on('data', (chunk: Buffer) => { responseData += chunk.toString(); });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(responseData);
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.message || 'HTTP ' + response.statusCode));
          }
        } catch {
          reject(new Error('Invalid JSON response'));
        }
      });
    });

    request.on('error', (err: Error) => reject(err));
    request.write(JSON.stringify(body));
    request.end();
  });
}

function _restDelete(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'DELETE', url });
    request.setHeader('Accept', 'application/json');
    const key = _apiKey();
    if (key) request.setHeader('Authorization', 'Bearer ' + key);

    request.on('response', (response) => {
      let data = '';
      response.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      response.on('end', () => resolve(data));
    });

    request.on('error', (err: Error) => reject(err));
    request.end();
  });
}

// ─── Status ─────────────────────────────────────────────────────

export function getStatus(): {
  lobbyConnected: boolean;
  audioConnected: boolean;
  sessionId: string | null;
  callId: string | null;
} {
  return {
    lobbyConnected: lobbyWs !== null && lobbyWs.readyState === WebSocket.OPEN,
    audioConnected: audioWs !== null && audioWs.readyState === WebSocket.OPEN,
    sessionId,
    callId,
  };
}

export function onTranscriptEvent(cb: (msg: any) => void): void { onTranscript = cb; }
export function onStatus(cb: (status: any) => void): void { onStatusChange = cb; }

function _fireStatus(): void {
  if (onStatusChange) onStatusChange(getStatus());
}
