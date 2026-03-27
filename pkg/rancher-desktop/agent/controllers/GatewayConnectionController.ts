/**
 * GatewayConnectionController — orchestrates when the gateway lobby listener
 * connects/disconnects based on integration config state.
 *
 * Decisions made here:
 *   - Whether config is complete enough to connect
 *   - When to reconnect on config changes (debounced)
 *   - Which gateway events to forward to the renderer
 *   - Audio session lifecycle (start/stop/send)
 *
 * Delegates all WebSocket/HTTP work to GatewayListenerService (the service layer).
 *
 * NOTE: Uses dynamic imports (await import()) to match codebase conventions
 * and avoid webpack chunk initialization order / circular dependency issues.
 */

import Logging from '@pkg/utils/logging';

const console = Logging.background;

// ─── Types ──────────────────────────────────────────────────────

/** Event types the renderer cares about for transcript display and audio playback */
const TRANSCRIPT_EVENT_TYPES = new Set(['transcript_turn', 'transcript_partial', 'agent_audio']);

type TranscriptForwarder = (event: { event_type: string; [key: string]: unknown }) => void;

// ─── Singleton ──────────────────────────────────────────────────

let instance: GatewayConnectionController | null = null;

export function getGatewayConnectionController(): GatewayConnectionController {
  if (!instance) {
    instance = new GatewayConnectionController();
  }
  return instance;
}

// ─── Controller ─────────────────────────────────────────────────

export class GatewayConnectionController {
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private eventUnsub: (() => void) | null = null;
  private transcriptForwarder: TranscriptForwarder | null = null;
  private audioIpcCount = 0;

  /**
   * Initialize the controller: check config and auto-connect if ready.
   * Also watches for config changes to reconnect.
   *
   * Called once from sullaEvents.ts after DB is ready.
   */
  async initialize(): Promise<void> {
    await this.evaluateAndConnect();

    const { getIntegrationService } = await import('../services/IntegrationService');
    const integrationService = getIntegrationService();
    integrationService.onValueChange((value, action) => {
      if (value.integration_id === 'enterprise_gateway' && (action === 'created' || action === 'updated')) {
        console.log(`[GatewayConnection] Config ${action}: ${value.property}, scheduling reconnect...`);
        this.scheduleReconnect();
      }
    });
  }

  /**
   * Check whether gateway config is complete and connect/disconnect accordingly.
   */
  async evaluateAndConnect(): Promise<void> {
    const config = await this.getConfig();
    const { getGatewayListenerService } = await import('../services/GatewayListenerService');
    const service = getGatewayListenerService();

    if (config) {
      await service.startLobby();
      console.log('[GatewayConnection] Lobby listener connected');
    } else {
      service.stopLobby();
      console.log('[GatewayConnection] Gateway not configured — lobby listener stopped');
    }
  }

  /**
   * Start an audio session on the gateway and return session info.
   */
  async startAudioSession(callerName?: string, options?: { channels?: Record<string, { label: string; source: string }> }): Promise<{ sessionId: string; callId: string }> {
    const { getGatewayListenerService } = await import('../services/GatewayListenerService');
    return getGatewayListenerService().startAudioStream(callerName, options);
  }

  /**
   * Stop the active audio session.
   */
  async stopAudioSession(): Promise<void> {
    const { getGatewayListenerService } = await import('../services/GatewayListenerService');
    await getGatewayListenerService().stopAudioStream();
  }

  /**
   * Forward an audio chunk to the gateway.
   * Includes rate-limited logging for diagnostics.
   */
  // Track per-channel counts separately for diagnostics
  private audioChCountCh0 = 0;
  private audioChCountCh1 = 0;

  async sendAudioChunk(data: Buffer | ArrayBuffer, channel: number = 0): Promise<void> {
    this.audioIpcCount++;
    if (channel === 0) this.audioChCountCh0++;
    else if (channel === 1) this.audioChCountCh1++;

    // Log first 5 per channel, then every 100th overall
    const chCount = channel === 0 ? this.audioChCountCh0 : this.audioChCountCh1;
    if (chCount <= 5 || this.audioIpcCount % 100 === 0) {
      const size = data instanceof ArrayBuffer ? data.byteLength : data.length;
      console.log(`[GatewayConnection] Audio IPC #${this.audioIpcCount} ch=${channel} chCount=${chCount} (${size} bytes)`);
    }
    const { getGatewayListenerService } = await import('../services/GatewayListenerService');
    getGatewayListenerService().sendAudio(data, channel);
  }

  /**
   * Reset the audio chunk counter (called when a new session starts).
   */
  resetAudioCount(): void {
    this.audioIpcCount = 0;
  }

  /**
   * Get the current gateway connection status.
   */
  async getStatus() {
    const { getGatewayListenerService } = await import('../services/GatewayListenerService');
    return getGatewayListenerService().getStatus();
  }

  /**
   * Subscribe to transcript events from the gateway and forward them
   * via the provided callback. Only transcript-relevant event types
   * are forwarded (transcript_turn, transcript_partial).
   */
  async subscribeTranscripts(forwarder: TranscriptForwarder): Promise<void> {
    this.unsubscribeTranscripts();

    const { getGatewayListenerService } = await import('../services/GatewayListenerService');
    const service = getGatewayListenerService();
    this.transcriptForwarder = forwarder;
    console.log('[GatewayConnection] Transcript subscription active');

    this.eventUnsub = service.onEvent((event) => {
      if (TRANSCRIPT_EVENT_TYPES.has(event.event_type)) {
        console.log(`[GatewayConnection] Forwarding ${event.event_type} to renderer`);
        try {
          this.transcriptForwarder?.(event);
        } catch (err) {
          console.warn(`[GatewayConnection] Transcript forward failed: ${err}`);
        }
      }
    });
  }

  /**
   * Unsubscribe from transcript event forwarding.
   */
  unsubscribeTranscripts(): void {
    if (this.eventUnsub) {
      this.eventUnsub();
      this.eventUnsub = null;
    }
    this.transcriptForwarder = null;
  }

  /**
   * Manually start the lobby listener.
   */
  async startLobby(): Promise<void> {
    const { getGatewayListenerService } = await import('../services/GatewayListenerService');
    await getGatewayListenerService().startLobby();
  }

  /**
   * Manually stop the lobby listener.
   */
  async stopLobby(): Promise<void> {
    const { getGatewayListenerService } = await import('../services/GatewayListenerService');
    getGatewayListenerService().stopLobby();
  }

  // ─── Private ──────────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.evaluateAndConnect().catch(err =>
        console.warn('[GatewayConnection] Reconnect failed:', err),
      );
    }, 1000);
  }

  private async getConfig(): Promise<{ url: string; apiKey: string } | null> {
    const { getIntegrationService } = await import('../services/IntegrationService');
    const integrationService = getIntegrationService();
    const [urlValue, keyValue] = await Promise.all([
      integrationService.getIntegrationValue('enterprise_gateway', 'gateway_url'),
      integrationService.getIntegrationValue('enterprise_gateway', 'api_key'),
    ]);

    const url = urlValue?.value?.trim();
    const apiKey = keyValue?.value?.trim();
    console.log(`[GatewayConnection] Config check: url=${url ? 'set' : 'missing'}, apiKey=${apiKey ? 'set' : 'missing'}`);

    if (url && apiKey) return { url, apiKey };
    return null;
  }
}
