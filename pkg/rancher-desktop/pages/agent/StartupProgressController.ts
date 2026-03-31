import { ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { IpcRendererEvent } from 'electron';

/** Backend states that mean the system is already booted */
const READY_STATES = new Set(['STARTED', 'DISABLED']);

export class StartupProgressController {
  private readinessInterval: ReturnType<typeof setInterval> | null = null;
  private k8sReady = false;
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

    // Query the backend state synchronously before deciding to show the overlay.
    // If the backend is already STARTED/DISABLED the system finished booting
    // (e.g. first-run already completed) — skip the overlay entirely.
    const backendState = this.queryBackendState();
    console.log('[StartupProgressController] initial backend state:', backendState);

    if (READY_STATES.has(backendState)) {
      console.log('[StartupProgressController] backend already ready — skipping overlay');
      this.markReady();
      // Still listen for restart events so overlay re-appears if the backend restarts
      ipcRenderer.on('sulla-main-started' as any, this.handleMainStarted);
      ipcRenderer.on('k8s-check-state' as any, this.handleStateChange);
      return;
    }

    // Backend is not ready — show overlay if this is a fresh session
    const hasSeenSplash = sessionStorage.getItem('sulla-startup-splash-seen') === 'true';

    if (!hasSeenSplash) {
      this.state.showOverlay.value = true;
    }

    this.state.progressMax.value = 100;
    this.state.progressCurrent.value = 0;
    this.state.progressDescription.value = 'Initializing...';
    this.state.systemReady.value = false;

    ipcRenderer.on('sulla-main-started' as any, this.handleMainStarted);
    ipcRenderer.on('k8s-progress', this.handleProgress);
    ipcRenderer.on('k8s-check-state' as any, this.handleStateChange);

    this.startReadinessCheck();
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

  /** Query the main process for the current backend state */
  private queryBackendState(): string {
    try {
      return String(ipcRenderer.sendSync('k8s-state'));
    } catch {
      console.log('[StartupProgressController] Failed to query backend state');
      return 'UNKNOWN';
    }
  }

  /** Mark the system as ready and hide the overlay */
  private markReady(): void {
    if (this.systemMarkedReady) return;
    this.systemMarkedReady = true;
    this.k8sReady = true;
    this.state.systemReady.value = true;
    this.state.showOverlay.value = false;
    this.state.progressDescription.value = 'System ready!';
    this.state.startupPhase.value = 'ready';
    sessionStorage.setItem('sulla-startup-splash-seen', 'true');

    if (this.readinessInterval) {
      clearInterval(this.readinessInterval);
      this.readinessInterval = null;
    }
  }

  /** Reset ready state when the backend restarts */
  private resetForStartup(): void {
    this.systemMarkedReady = false;
    this.k8sReady = false;
    this.state.showOverlay.value = true;
    this.state.progressMax.value = 100;
    this.state.progressCurrent.value = 0;
    this.state.progressDescription.value = 'System restarting...';
    this.state.startupPhase.value = 'initializing';
    this.state.systemReady.value = false;

    // Re-listen for progress (may have been removed after ready)
    ipcRenderer.removeListener('k8s-progress', this.handleProgress);
    ipcRenderer.on('k8s-progress', this.handleProgress);
    this.startReadinessCheck();
  }

  /**
   * Handle backend state change events. If the backend transitions to a
   * ready state, hide the overlay. If it transitions away, show it.
   */
  private readonly handleStateChange = (_event: any, state: any) => {
    const stateStr = String(state);

    console.log('[StartupProgressController] k8s-check-state:', stateStr);

    if (READY_STATES.has(stateStr)) {
      this.markReady();
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

    // Only show overlay if we're genuinely starting up
    if (!this.state.showOverlay.value) {
      this.state.showOverlay.value = true;
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

    if (progress.max > 0 && progress.current >= progress.max) {
      this.k8sReady = true;
    }
  };

  private readonly handleMainStarted = () => {
    console.log('[StartupProgressController] Main process restarted - showing overlay');
    this.resetForStartup();
  };

  private startReadinessCheck(): void {
    if (this.readinessInterval) return;

    this.readinessInterval = setInterval(async() => {
      if (!this.k8sReady) return;

      if (this.state.modelDownloading.value) {
        return;
      }

      this.markReady();
      window.location.reload();
    }, 3000);
  }
}
