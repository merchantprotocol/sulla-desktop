import { ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { IpcRendererEvent } from 'electron';

/** Backend states that mean the system is already booted */
const READY_STATES = new Set(['STARTED', 'DISABLED']);

interface LifecycleStatus {
  ready: boolean;
  shuttingDown: boolean;
}

export class StartupProgressController {
  private readinessInterval: ReturnType<typeof setInterval> | null = null;
  private systemMarkedReady = false;

  static createState() {
    return {
      systemReady:         ref(false),
      progressCurrent:     ref(0),
      progressMax:         ref(100),
      progressDescription: ref('Starting Sulla...'),
      startupPhase:        ref('initializing'),
      showOverlay:         ref(false),

      modelDownloading:    ref(false),
      modelName:           ref(''),
      modelDownloadStatus: ref(''),

      modelMode: ref<'local' | 'remote'>('local'),
    };
  }

  constructor(public readonly state: ReturnType<typeof StartupProgressController.createState>) {}

  start(): void {
    console.log('[StartupProgressController] start() called');

    // Query actual system state — these are the sources of truth
    const backendState = this.queryBackendState();
    const lifecycle = this.queryLifecycleStatus();

    console.log('[StartupProgressController] initial state — backend:', backendState, 'lifecycle:', JSON.stringify(lifecycle));

    // Always listen for state changes (restart, shutdown, etc.)
    this.attachListeners();

    if (READY_STATES.has(backendState) && lifecycle.ready) {
      console.log('[StartupProgressController] system already ready — skipping overlay');
      this.markReady();

      return;
    }

    // System is not fully ready — show the startup overlay and poll until ready
    this.state.showOverlay.value = true;
    this.state.progressMax.value = 100;
    this.state.progressCurrent.value = 0;
    this.state.progressDescription.value = lifecycle.shuttingDown ? 'Shutting down...' : 'Initializing...';
    this.state.systemReady.value = false;

    this.startReadinessPolling();
  }

  dispose(): void {
    ipcRenderer.removeListener('sulla-main-started' as any, this.handleMainStarted);
    ipcRenderer.removeListener('k8s-progress', this.handleProgress);
    ipcRenderer.removeListener('k8s-check-state' as any, this.handleStateChange);

    if (this.readinessInterval) {
      clearInterval(this.readinessInterval);
      this.readinessInterval = null;
    }
  }

  private attachListeners(): void {
    ipcRenderer.on('sulla-main-started' as any, this.handleMainStarted);
    ipcRenderer.on('k8s-progress', this.handleProgress);
    ipcRenderer.on('k8s-check-state' as any, this.handleStateChange);
  }

  /** Query the main process for the current backend state */
  private queryBackendState(): string {
    try {
      return String(ipcRenderer.sendSync('k8s-state'));
    } catch {
      console.log('[StartupProgressController] Failed to query backend state');

      return 'UNKNOWN';
    }
  }

  /** Query the lifecycle manager for service readiness */
  private queryLifecycleStatus(): LifecycleStatus {
    try {
      return ipcRenderer.sendSync('lifecycle:status') as LifecycleStatus;
    } catch {
      console.log('[StartupProgressController] Failed to query lifecycle status');

      return { ready: false, shuttingDown: false };
    }
  }

  /** Check both sources of truth for system readiness */
  private isSystemReady(): boolean {
    const backendState = this.queryBackendState();
    const lifecycle = this.queryLifecycleStatus();

    return READY_STATES.has(backendState) && lifecycle.ready;
  }

  /** Mark the system as ready and hide the overlay */
  private markReady(): void {
    if (this.systemMarkedReady) {
      return;
    }
    this.systemMarkedReady = true;
    this.state.systemReady.value = true;
    this.state.showOverlay.value = false;
    this.state.progressDescription.value = 'System ready!';
    this.state.startupPhase.value = 'ready';

    if (this.readinessInterval) {
      clearInterval(this.readinessInterval);
      this.readinessInterval = null;
    }
  }

  /** Reset ready state when the backend restarts */
  private resetForStartup(): void {
    this.systemMarkedReady = false;
    this.state.showOverlay.value = true;
    this.state.progressMax.value = 100;
    this.state.progressCurrent.value = 0;
    this.state.progressDescription.value = 'System restarting...';
    this.state.startupPhase.value = 'initializing';
    this.state.systemReady.value = false;

    this.startReadinessPolling();
  }

  /**
   * Handle backend state change events. If the backend transitions to a
   * ready state, hide the overlay. If it transitions away, show it.
   */
  private readonly handleStateChange = (_event: any, state: any) => {
    const stateStr = String(state);

    console.log('[StartupProgressController] k8s-check-state:', stateStr);

    if (READY_STATES.has(stateStr)) {
      // Backend is ready — verify lifecycle agrees before hiding overlay
      const lifecycle = this.queryLifecycleStatus();

      if (lifecycle.ready) {
        this.markReady();
      }
    } else if (stateStr === 'STARTING' || stateStr === 'STOPPING') {
      // Backend is (re)starting — show overlay
      if (this.systemMarkedReady) {
        this.resetForStartup();
      }
    }
  };

  private readonly handleModelStatus = (
    _event: IpcRendererEvent,
    payload: { status: string; model?: string },
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

    // If system is already marked ready, ignore stale progress events
    if (this.systemMarkedReady) {
      console.log('[StartupProgressController] ignoring progress — system already ready');

      return;
    }

    if (progress.max > 0) {
      this.state.progressCurrent.value = progress.current;
      this.state.progressMax.value = progress.max;
    } else if (progress.max === -1) {
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
  };

  private readonly handleMainStarted = () => {
    console.log('[StartupProgressController] Main process restarted - showing overlay');
    this.resetForStartup();
  };

  /**
   * Poll the actual system state every 3 seconds as a safety net.
   * This catches cases where IPC events were missed (e.g. listener
   * attached after the event fired, or page reload mid-startup).
   */
  private startReadinessPolling(): void {
    if (this.readinessInterval) {
      return;
    }

    this.readinessInterval = setInterval(() => {
      if (this.systemMarkedReady) {
        return;
      }

      if (this.state.modelDownloading.value) {
        return;
      }

      // Poll actual state — this is the source of truth
      if (this.isSystemReady()) {
        console.log('[StartupProgressController] readiness poll: system ready — hiding overlay');
        this.markReady();
      }
    }, 3000);
  }
}
