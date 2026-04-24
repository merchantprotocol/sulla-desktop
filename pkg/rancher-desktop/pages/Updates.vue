<template>
  <div class="updates-root">
    <div class="updates-window">
      <!-- Header -->
      <header class="updates-header">
        <div class="updates-brand">
          <div class="updates-icon" :class="phaseIconClass">
            <svg
              v-if="phase === 'downloaded'"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <svg
              v-else-if="phase === 'not-available'"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <svg
              v-else-if="phase === 'error'"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <svg
              v-else
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </div>
          <div class="updates-title-block">
            <h1 class="updates-title">
              Sulla Desktop
            </h1>
            <p class="updates-subtitle">
              Software Updates
            </p>
          </div>
        </div>
      </header>

      <!-- Body -->
      <main class="updates-body">
        <!-- CHECKING -->
        <section v-if="phase === 'checking'" class="state-block">
          <div class="spinner" />
          <h2 class="state-headline">
            Checking for updates…
          </h2>
          <p class="state-sub">
            Contacting update server
          </p>
        </section>

        <!-- UP TO DATE -->
        <section v-else-if="phase === 'not-available'" class="state-block">
          <div class="success-circle">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <h2 class="state-headline">
            You're up to date
          </h2>
          <p class="state-sub">
            Sulla Desktop {{ currentVersion ? 'v' + currentVersion : '' }} is the latest version.
          </p>
          <div class="state-actions">
            <button class="btn-secondary" @click="onCheckAgain">
              Check Again
            </button>
            <button class="btn-primary" @click="onClose">
              Close
            </button>
          </div>
        </section>

        <!-- AVAILABLE (pre-download) -->
        <section v-else-if="phase === 'available'" class="state-block">
          <div class="info-badge">
            Update Available
          </div>
          <h2 class="state-headline">
            Sulla Desktop v{{ availableVersion }}
          </h2>
          <p class="state-sub">
            A new version is available. Currently running v{{ currentVersion }}.
          </p>
          <div v-if="releaseNotesHtml" class="release-notes">
            <h3>Release Notes</h3>
            <div class="notes-body" v-html="releaseNotesHtml" />
          </div>

          <!-- Packaged build: normal download flow -->
          <template v-if="isPackaged">
            <p class="state-sub" style="margin-top:12px;">
              Downloading in the background…
            </p>
            <div class="state-actions">
              <button class="btn-secondary" @click="onClose">
                Close
              </button>
            </div>
          </template>

          <!-- Dev build: can check but not install -->
          <template v-else>
            <div class="dev-notice">
              <strong>Development build</strong> — install isn't available from this
              build. Download the latest release from GitHub and install manually.
            </div>
            <div class="state-actions">
              <button class="btn-secondary" @click="onClose">
                Close
              </button>
              <button class="btn-primary" @click="onOpenReleases">
                Open Releases Page
              </button>
            </div>
          </template>
        </section>

        <!-- DOWNLOADING -->
        <section v-else-if="phase === 'downloading'" class="state-block">
          <div class="info-badge">
            Downloading Update
          </div>
          <h2 class="state-headline">
            Sulla Desktop v{{ availableVersion }}
          </h2>
          <div class="progress-container">
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: progressPercent + '%' }" />
            </div>
            <div class="progress-meta">
              <span>{{ progressPercent }}%</span>
              <span>{{ progressSpeed }}</span>
              <span>{{ progressTransferred }} / {{ progressTotal }}</span>
            </div>
          </div>
          <p class="state-sub">
            Please keep Sulla Desktop open while the update downloads.
          </p>
        </section>

        <!-- DOWNLOADED — READY TO INSTALL -->
        <section v-else-if="phase === 'downloaded'" class="state-block">
          <div class="success-circle ready">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <h2 class="state-headline">
            Update Ready to Install
          </h2>
          <p class="state-sub">
            Sulla Desktop v{{ availableVersion }} has been downloaded.
            Restart the app to finish installing.
          </p>
          <div v-if="releaseNotesHtml" class="release-notes">
            <h3>Release Notes</h3>
            <div class="notes-body" v-html="releaseNotesHtml" />
          </div>
          <div class="state-actions">
            <button class="btn-secondary" @click="onClose">
              {{ isPackaged ? 'Install on Next Restart' : 'Close' }}
            </button>
            <button
              v-if="isPackaged"
              class="btn-primary btn-install"
              :disabled="installing"
              @click="onInstall"
            >
              {{ installing ? 'Restarting…' : 'Install & Restart Now' }}
            </button>
          </div>
        </section>

        <!-- ERROR -->
        <section v-else-if="phase === 'error'" class="state-block">
          <div class="error-circle">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h2 class="state-headline">
            Couldn't check for updates
          </h2>
          <p class="state-sub error-text">
            {{ errorMessage || 'An unknown error occurred.' }}
          </p>
          <div class="state-actions">
            <button class="btn-secondary" @click="onClose">
              Close
            </button>
            <button class="btn-primary" @click="onCheckAgain">
              Try Again
            </button>
          </div>
        </section>

        <!-- DISABLED (dev build / no config) -->
        <section v-else-if="phase === 'disabled'" class="state-block">
          <div class="info-badge">
            Updates Unavailable
          </div>
          <h2 class="state-headline">
            Auto-update is not configured
          </h2>
          <p class="state-sub">
            This build of Sulla Desktop isn't connected to the update server.
            Development builds skip update checks.
          </p>
          <p class="state-sub" style="margin-top:8px;">
            Running v{{ currentVersion }}
          </p>
          <div class="state-actions">
            <button class="btn-primary" @click="onClose">
              Close
            </button>
          </div>
        </section>

        <!-- IDLE fallback -->
        <section v-else class="state-block">
          <h2 class="state-headline">
            Updates
          </h2>
          <p class="state-sub">
            Running Sulla Desktop v{{ currentVersion }}
          </p>
          <div class="state-actions">
            <button class="btn-primary" @click="onCheckAgain">
              Check for Updates
            </button>
          </div>
        </section>
      </main>

      <!-- Footer -->
      <footer class="updates-footer">
        <span class="footer-version">
          Current: v{{ currentVersion }}
          <template v-if="lastCheckedAt"> · Last checked {{ lastCheckedText }}</template>
        </span>
      </footer>
    </div>
  </div>
</template>

<script lang="ts">
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { defineComponent } from 'vue';

import type { RichUpdateState, UpdatePhase } from '@pkg/main/update/UpdateManager';

const { ipcRenderer } = require('electron');

function formatBytes(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes)) {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;

  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }

  return `${ n.toFixed(n >= 100 ? 0 : 1) } ${ units[i] }`;
}

export default defineComponent({
  name: 'Updates',

  data() {
    return {
      state: null as RichUpdateState | null,
      installing: false,
      nowTick: Date.now(),
      tickTimer: null as ReturnType<typeof setInterval> | null,
    };
  },

  computed: {
    phase(): UpdatePhase {
      return this.state?.phase ?? 'idle';
    },
    phaseIconClass(): string {
      switch (this.phase) {
      case 'downloaded': return 'icon-success';
      case 'not-available': return 'icon-success';
      case 'error': return 'icon-error';
      default: return '';
      }
    },
    currentVersion(): string {
      return this.state?.currentVersion ?? '';
    },
    availableVersion(): string {
      return this.state?.availableVersion ?? '';
    },
    errorMessage(): string {
      return this.state?.error ?? '';
    },
    isPackaged(): boolean {
      return !!this.state?.isPackaged;
    },
    releaseNotesHtml(): string | null {
      const markdown = this.state?.releaseNotes;

      if (typeof markdown !== 'string' || !markdown.trim()) {
        return null;
      }
      const unsanitized = marked(markdown) as string;

      return DOMPurify.sanitize(unsanitized, { USE_PROFILES: { html: true } });
    },
    progressPercent(): number {
      return Math.floor(this.state?.progress?.percent ?? 0);
    },
    progressSpeed(): string {
      const bps = this.state?.progress?.bytesPerSecond;

      if (!bps) {
        return '';
      }

      return `${ formatBytes(bps) }/s`;
    },
    progressTransferred(): string {
      return formatBytes(this.state?.progress?.transferred);
    },
    progressTotal(): string {
      return formatBytes(this.state?.progress?.total);
    },
    lastCheckedAt(): number | undefined {
      return this.state?.lastCheckedAt;
    },
    lastCheckedText(): string {
      const ts = this.state?.lastCheckedAt;

      if (!ts) {
        return '';
      }
      const delta = Math.max(0, this.nowTick - ts);
      const secs = Math.floor(delta / 1000);

      if (secs < 60) {
        return `${ secs }s ago`;
      }
      if (secs < 3600) {
        return `${ Math.floor(secs / 60) }m ago`;
      }

      return `${ Math.floor(secs / 3600) }h ago`;
    },
  },

  async mounted() {
    ipcRenderer.on('updater:state', this.onStateEvent);

    try {
      this.state = await ipcRenderer.invoke('updater:get-state');
    } catch (err) {
      // No-op; we'll populate on the first broadcast.
      console.warn('[Updates] get-state failed', err);
    }

    // If we're opened in idle, kick off a manual check immediately.
    if (!this.state || this.state.phase === 'idle') {
      this.triggerCheck();
    }

    this.tickTimer = setInterval(() => {
      this.nowTick = Date.now();
    }, 1000);
  },

  beforeUnmount() {
    ipcRenderer.off('updater:state', this.onStateEvent);
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
    }
  },

  methods: {
    onStateEvent(_event: unknown, state: RichUpdateState) {
      this.state = state;
      // Reset the local installing flag if the main process rejects or resets.
      if (this.installing && state.phase !== 'downloaded') {
        this.installing = false;
      }
    },
    triggerCheck() {
      ipcRenderer.send('updater:check', 'manual');
    },
    onCheckAgain() {
      this.triggerCheck();
    },
    onInstall() {
      this.installing = true;
      ipcRenderer.send('updater:install');
    },
    onClose() {
      window.close();
    },
    onOpenReleases() {
      const { shell } = require('electron');

      shell.openExternal('https://github.com/merchantprotocol/sulla-desktop/releases/latest');
    },
  },
});
</script>

<style lang="scss" scoped>
  .updates-root {
    min-height: 100vh;
    background: #0d1117;
    color: #c9d1d9;
    font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    display: flex;
    align-items: stretch;
    justify-content: stretch;
  }

  .updates-window {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 28px 36px 20px;
  }

  .updates-header {
    display: flex;
    align-items: center;
    padding-bottom: 20px;
    border-bottom: 1px solid #21262d;
  }

  .updates-brand {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .updates-icon {
    width: 44px;
    height: 44px;
    border-radius: 10px;
    background: linear-gradient(135deg, #1e3a4f, #0d1117);
    border: 1px solid #30363d;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #6ab0cc;

    &.icon-success {
      color: #3fb950;
      border-color: #1a4a24;
      background: linear-gradient(135deg, #0d2f17, #0d1117);
    }

    &.icon-error {
      color: #f85149;
      border-color: #5a1f1f;
      background: linear-gradient(135deg, #3d1212, #0d1117);
    }
  }

  .updates-title-block {
    display: flex;
    flex-direction: column;
  }

  .updates-title {
    font-family: 'Playfair Display', serif;
    font-size: 20px;
    font-weight: 600;
    color: #f0f6fc;
    margin: 0;
    letter-spacing: 0.02em;
  }

  .updates-subtitle {
    font-size: 11px;
    color: #8b949e;
    margin: 2px 0 0;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .updates-body {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px 0;
  }

  .state-block {
    text-align: center;
    max-width: 460px;
    width: 100%;
  }

  .state-headline {
    font-family: 'Playfair Display', serif;
    font-size: 26px;
    font-weight: 600;
    color: #f0f6fc;
    margin: 18px 0 8px;
  }

  .state-sub {
    font-size: 13px;
    color: #b1bac4;
    line-height: 1.5;
    margin: 0;
  }

  .error-text {
    color: #f85149;
  }

  .state-actions {
    display: flex;
    gap: 10px;
    justify-content: center;
    margin-top: 24px;
    flex-wrap: wrap;
  }

  .btn-primary,
  .btn-secondary {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 12px;
    font-weight: 500;
    padding: 10px 20px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
    letter-spacing: 0.02em;
  }

  .btn-primary {
    background: linear-gradient(180deg, #6ab0cc, #5096b3);
    border: 1px solid #5096b3;
    color: #0d1117;

    &:hover:not(:disabled) {
      background: linear-gradient(180deg, #7dc0dc, #6ab0cc);
      box-shadow: 0 0 12px rgba(106, 176, 204, 0.3);
    }

    &:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    &.btn-install {
      background: linear-gradient(180deg, #3fb950, #2ea043);
      border-color: #2ea043;
      color: #0d1117;

      &:hover:not(:disabled) {
        background: linear-gradient(180deg, #4fc960, #3fb950);
        box-shadow: 0 0 12px rgba(63, 185, 80, 0.3);
      }
    }
  }

  .btn-secondary {
    background: transparent;
    border: 1px solid #30363d;
    color: #c9d1d9;

    &:hover {
      background: #161b22;
      border-color: #484f58;
    }
  }

  .spinner {
    width: 48px;
    height: 48px;
    border: 3px solid #21262d;
    border-top-color: #6ab0cc;
    border-radius: 50%;
    margin: 0 auto 8px;
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .success-circle {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: linear-gradient(135deg, #0d2f17, #1a4a24);
    border: 2px solid #3fb950;
    color: #3fb950;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto;
    box-shadow: 0 0 20px rgba(63, 185, 80, 0.15);

    &.ready {
      box-shadow: 0 0 24px rgba(63, 185, 80, 0.35);
    }
  }

  .error-circle {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: linear-gradient(135deg, #3d1212, #5a1f1f);
    border: 2px solid #f85149;
    color: #f85149;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto;
    box-shadow: 0 0 20px rgba(248, 81, 73, 0.15);
  }

  .info-badge {
    display: inline-block;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    color: #6ab0cc;
    background: rgba(106, 176, 204, 0.1);
    border: 1px solid rgba(106, 176, 204, 0.3);
    padding: 4px 12px;
    border-radius: 12px;
  }

  .dev-notice {
    margin: 20px auto 0;
    max-width: 440px;
    padding: 12px 16px;
    border: 1px solid rgba(227, 179, 65, 0.4);
    background: rgba(227, 179, 65, 0.08);
    border-radius: 6px;
    font-size: 12px;
    color: #e3b341;
    line-height: 1.6;
    text-align: left;

    strong {
      color: #f0c653;
      font-weight: 600;
    }
  }

  .progress-container {
    margin: 28px auto 16px;
    max-width: 360px;
  }

  .progress-bar {
    height: 8px;
    background: #161b22;
    border: 1px solid #21262d;
    border-radius: 4px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #5096b3, #6ab0cc);
    transition: width 0.3s ease;
    box-shadow: 0 0 8px rgba(106, 176, 204, 0.4);
  }

  .progress-meta {
    display: flex;
    justify-content: space-between;
    margin-top: 8px;
    font-size: 11px;
    color: #8b949e;
    font-variant-numeric: tabular-nums;
  }

  .release-notes {
    text-align: left;
    margin: 24px auto 0;
    max-width: 440px;
    max-height: 180px;
    overflow-y: auto;
    border: 1px solid #21262d;
    border-radius: 6px;
    padding: 12px 16px;
    background: #0a0d13;

    h3 {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: #8b949e;
      margin: 0 0 8px;
      font-weight: 600;
    }
  }

  .notes-body {
    font-size: 12px;
    color: #c9d1d9;
    line-height: 1.6;

    :deep(p) {
      margin: 6px 0;
    }

    :deep(ul), :deep(ol) {
      padding-left: 18px;
      margin: 6px 0;
    }

    :deep(code) {
      background: #161b22;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 11px;
    }
  }

  .updates-footer {
    padding-top: 12px;
    border-top: 1px solid #21262d;
    font-size: 10px;
    color: #6e7681;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    text-align: center;
  }
</style>
