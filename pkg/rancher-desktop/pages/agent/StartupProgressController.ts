import { computed, ref } from 'vue';
import type { ComputedRef, Ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { IpcRendererEvent } from 'electron';


export class StartupProgressController {

  private readonly WS_URL = 'ws://localhost:30118/';
  private readinessInterval: ReturnType<typeof setInterval> | null = null;
  private k8sReady = false;
  private receivedProgress = false;
  private wsProbeAttempted = false;

  /**
   * 
   */
  static createState() {
    const progressCurrent = ref(0);
    const progressMax = ref(100); // Start at 100 so overlay shows immediately

    return {
      systemReady:         ref(false),
      progressCurrent,
      progressMax,
      progressDescription: ref('Starting Sulla...'),
      startupPhase:        ref('initializing'),
      showOverlay:         ref(false), // Controls overlay visibility

      modelDownloading:    ref(false),
      modelName:           ref(''),
      modelDownloadStatus: ref(''),

      modelMode:           ref<'local' | 'remote'>('local'),
    };
  }

  /**
   * 
   * @param state 
   */
  constructor(public readonly state: ReturnType<typeof StartupProgressController.createState>) {}

  /**
   * 
   */
  start(): void {
    console.log('[StartupProgressController] start() called');
    // Check if we've seen the startup splash in this session
    const hasSeenSplash = sessionStorage.getItem('sulla-startup-splash-seen') === 'true';
    
    // If not seen, show overlay immediately on new bootup
    if (!hasSeenSplash) {
      this.state.showOverlay.value = true;
    }
    
    // Initialize overlay state immediately so popup shows right away
    this.state.progressMax.value = 100;
    this.state.progressCurrent.value = 0;
    console.log('[StartupProgressController] initial state: progressMax=', this.state.progressMax.value, 'progressCurrent=', this.state.progressCurrent.value);
    this.state.progressDescription.value = 'Initializing...';
    this.state.systemReady.value = false;
    
    // Listen for main process restart to show overlay
    ipcRenderer.on('sulla-main-started' as any, this.handleMainStarted);
    
    ipcRenderer.on('k8s-progress', this.handleProgress);

    this.startReadinessCheck();
    this.probeWebSocket();
  }

  dispose(): void {
    ipcRenderer.removeListener('sulla-main-started' as any, this.handleMainStarted);
    ipcRenderer.removeListener('k8s-progress', this.handleProgress);
    if (this.readinessInterval) {
      clearInterval(this.readinessInterval);
      this.readinessInterval = null;
    }
  }

  private readonly handleModelStatus = (
    event: IpcRendererEvent,
    payload: { status: string; model?: string }
  ) => {
    this.state.modelDownloading.value =
      payload.status.includes('Downloading') ||
      payload.status.includes('pulling') ||
      payload.status.includes('Extracting');

    this.state.modelName.value = payload.model || this.state.modelName.value;
    this.state.modelDownloadStatus.value = payload.status;

    if (payload.status === 'success' || payload.status.includes('complete')) {
      this.state.modelDownloading.value = false;
      this.state.modelDownloadStatus.value = 'Model ready';
      this.state.showOverlay.value = false;
    }
  };

  private readonly handleProgress = (_: unknown, progress: { current: number; max: number; description?: string }) => {
    console.log('[StartupProgressController] handleProgress:', progress);
    this.receivedProgress = true;
    // Show overlay on any progress event
    this.state.showOverlay.value = true;
    
    // If we got a real progress update, use those values instead of restart placeholder
    if (progress.max > 0) {
      this.state.progressCurrent.value = progress.current;
      this.state.progressMax.value = progress.max;
    } else if (progress.max === -1) {
      // Indeterminate progress, simulate by incrementing current
      this.state.progressCurrent.value = Math.min(this.state.progressCurrent.value + 10, this.state.progressMax.value);
    }
    this.state.progressDescription.value = progress.description || this.state.progressDescription.value;

    if (
      progress.description?.includes('Kubernetes') ||
      progress.description?.includes('deployment') ||
      progress.description?.includes('pod')
    ) {
      this.state.startupPhase.value = 'pods';
    } else {
      this.state.startupPhase.value = 'k8s';
    }

    if (progress.max > 0 && progress.current >= progress.max) {
      this.k8sReady = true;
    }
  };

  private readonly handleMainStarted = () => {
    console.log('[StartupProgressController] Main process restarted - showing overlay');
    this.state.showOverlay.value = true;

    // Set progressMax to trigger overlay display
    this.state.progressMax.value = 100;
    this.state.progressCurrent.value = 0;
    this.state.progressDescription.value = 'System restarting...';
    this.state.startupPhase.value = 'initializing';
    this.state.systemReady.value = false;
    this.k8sReady = false;
  };

  /**
   * Probe the websocket to see if services are already running.
   * If the connection succeeds and we haven't received any progress events,
   * the system is already up — close the overlay.
   */
  private probeWebSocket(): void {
    if (this.wsProbeAttempted) return;
    this.wsProbeAttempted = true;

    console.log('[StartupProgressController] Probing websocket at', this.WS_URL);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.WS_URL);
    } catch {
      console.log('[StartupProgressController] WebSocket probe failed to create');
      return;
    }

    const cleanup = () => {
      try { ws.close(); } catch {}
    };

    // Give the probe 5 seconds to connect
    const timeout = setTimeout(() => {
      console.log('[StartupProgressController] WebSocket probe timed out');
      cleanup();
    }, 5000);

    ws.onopen = () => {
      clearTimeout(timeout);
      console.log('[StartupProgressController] WebSocket probe connected');
      if (!this.receivedProgress) {
        console.log('[StartupProgressController] No progress events received — services already running, closing overlay');
        this.state.systemReady.value = true;
        this.state.showOverlay.value = false;
        this.state.progressDescription.value = 'System ready!';
        this.state.startupPhase.value = 'ready';
        sessionStorage.setItem('sulla-startup-splash-seen', 'true');
      }
      cleanup();
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      console.log('[StartupProgressController] WebSocket probe failed — services not yet available');
      cleanup();
    };
  }

  private startReadinessCheck(): void {
    this.readinessInterval = setInterval(async () => {
      if (!this.k8sReady) return;


      if (this.state.modelDownloading.value) {
        return; // model status already updating via event
      }

      this.state.startupPhase.value = 'ready';
      this.state.progressDescription.value = 'System ready!';
      this.state.systemReady.value = true;
      // Refresh the page instead of hiding overlay
      window.location.reload();

      // Mark that we've seen the startup splash in this session
      sessionStorage.setItem('sulla-startup-splash-seen', 'true');

      clearInterval(this.readinessInterval!);
      this.readinessInterval = null;
    }, 3000);
  }

}