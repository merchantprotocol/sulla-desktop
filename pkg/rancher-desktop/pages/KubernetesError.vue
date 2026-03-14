<template>
  <div class="container">
    <PostHogTracker page-name="KubernetesError" />
    <div class="page-body">
      <div class="error-header">
        <img
          id="logo"
          src="../../../resources/icons/logo-square-red@2x.png"
        >
        <span>
          <h2 data-test="k8s-error-header">
            {{ t('app.name') }} Error
          </h2>
          <h5>{{ versionString }}</h5>
        </span>
      </div>
      <div class="k8s-error">
        <div class="error-part">
          <h4>{{ titlePart }}</h4>
          <pre id="main-message">{{ mainMessage }}</pre>
        </div>
        <div
          v-if="lastCommand"
          class="error-part command"
        >
          <h4>Last command run:</h4>
          <p>{{ lastCommand }}</p>
        </div>
        <div
          v-if="lastCommandComment"
          class="error-part"
        >
          <h4>Context:</h4>
          <p>{{ lastCommandComment }}</p>
        </div>
        <div
          v-if="lastLogLines.length"
          class="error-part grow"
        >
          <h4>
            Some recent <a
              href="#"
              @click.prevent="showLogs"
            >logfile</a> lines:
          </h4>
          <pre id="log-lines">{{ joinedLastLogLines }}</pre>
        </div>
      </div>
    </div>
    <div class="actions-bar">
      <div class="report-section">
        <div
          v-if="reportStatus === 'success'"
          class="report-confirmation"
        >
          Thank you! Your report has been submitted.
        </div>
        <div
          v-else-if="reportStatus === 'error'"
          class="report-error"
        >
          Could not submit report. Please try again or file an issue on GitHub.
        </div>
        <template v-else>
          <label class="notify-checkbox">
            <input
              v-model="wantNotification"
              type="checkbox"
            >
            Notify me when this is fixed
          </label>
          <input
            v-if="wantNotification"
            v-model="notifyEmail"
            type="email"
            class="email-input"
            placeholder="your@email.com"
          >
        </template>
      </div>
      <div class="action-buttons">
        <button
          data-test="report-btn"
          class="role-primary"
          :disabled="reportStatus === 'sending' || reportStatus === 'success'"
          @click="sendReport"
        >
          {{ reportButtonLabel }}
        </button>
        <button
          data-test="accept-btn"
          @click="close"
        >
          Close
        </button>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import os from 'os';

import { defineComponent } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import PostHogTracker from '@pkg/components/PostHogTracker.vue';

export default defineComponent({
  name:   'kubernetes-error-dialog',
  layout: 'dialog',
  components: { PostHogTracker },
  data() {
    return {
      titlePart:          '',
      mainMessage:        '',
      lastCommand:        '',
      lastCommandComment: '',
      lastLogLines:       [] as string[],
      appVersion:         '',
      reportStatus:       'idle' as 'idle' | 'sending' | 'success' | 'error',
      wantNotification:   false,
      notifyEmail:        '',
    };
  },
  computed: {
    joinedLastLogLines(): string {
      return this.lastLogLines.join('\n');
    },
    platform(): string {
      return os.platform();
    },
    arch(): string {
      const arch = os.arch();

      return arch === 'arm64' ? 'aarch64' : arch;
    },
    versionString(): string {
      return `Sulla Desktop ${ this.appVersion } - ${ this.platform } (${ this.arch })`;
    },
    reportButtonLabel(): string {
      switch (this.reportStatus) {
      case 'sending': return 'Sending...';
      case 'success': return 'Sent!';
      default:        return 'Send Report';
      }
    },
  },
  beforeMount() {
    ipcRenderer.on('get-app-version', (_event, version) => {
      this.appVersion = version;
    });
    ipcRenderer.send('get-app-version');
  },
  mounted() {
    ipcRenderer.on('dialog/populate', (event, titlePart, mainMessage, failureDetails) => {
      this.$data.titlePart = titlePart;
      this.$data.mainMessage = mainMessage;
      this.$data.lastCommand = failureDetails.lastCommand;
      this.$data.lastCommandComment = failureDetails.lastCommandComment;
      this.$data.lastLogLines = failureDetails.lastLogLines;
    });
    // Tell the dialog layout to set flex on the height.
    document.documentElement.setAttribute('data-flex', 'height');
  },
  methods: {
    close() {
      window.close();
    },
    showLogs() {
      ipcRenderer.send('show-logs');
    },
    async sendReport() {
      if (this.reportStatus === 'sending' || this.reportStatus === 'success') {
        return;
      }

      this.reportStatus = 'sending';

      const stackParts = [
        this.lastCommand ? `Command: ${ this.lastCommand }` : '',
        this.lastCommandComment ? `Context: ${ this.lastCommandComment }` : '',
        this.joinedLastLogLines ? `Log lines:\n${ this.joinedLastLogLines }` : '',
      ].filter(Boolean);

      const report = {
        error_type:    'app_error',
        error_message: `${ this.titlePart }: ${ this.mainMessage }`,
        stack_trace:   stackParts.join('\n\n'),
        user_context:  `KubernetesError dialog — ${ this.versionString }`,
        notify_email:  this.wantNotification && this.notifyEmail ? this.notifyEmail : undefined,
      };

      try {
        const result = await ipcRenderer.invoke('error-report/invoke', report);

        this.reportStatus = result?.success ? 'success' : 'error';
      } catch {
        this.reportStatus = 'error';
      }
    },
  },
});
</script>

<style lang="scss" scoped>
  .container {
    min-width: 52rem;
  }

  .error-header {
    display: flex;
    gap: 0.75rem;
    h2 {
      margin-top: 0.25rem;
    }
  }

  img#logo {
    height: 32px;
    width: 32px;
  }
  .page-body {
    display: flex;
    flex-grow: 1;
    flex-flow: column;
  }
  .k8s-error {
    display: flex;
    flex-grow: 1;
    flex-flow: column;
  }
  pre#log-lines {
    height: 8rem;
    white-space: pre-wrap;
    text-indent: -4em;
    padding-left: 4em;
    min-width: 80vw; /* 80% of viewport-width as specified in createWindow() in window/index.ts */
  }
  pre#main-message {
    white-space: pre-line;
    min-width: 80vw; /* See comment for pre#log-lines */
  }

  .error-part {
    margin-top: 0.5rem;
    margin-bottom: 1.5rem;
    h4 {
      margin-top: auto;
    }
    &.command p {
      font-family: monospace;
      white-space: pre-wrap;
    }
    &.grow {
      display: flex;
      flex-flow: column;
      flex-grow: 1;
      & > *:not(h4) {
        flex-grow: 1;
      }
    }
  }

  .actions-bar {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 1rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
  }

  .report-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    flex: 1;
  }

  .notify-checkbox {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    cursor: pointer;
    user-select: none;

    input[type="checkbox"] {
      cursor: pointer;
    }
  }

  .email-input {
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 0.85rem;
    max-width: 260px;
    background: var(--input-bg);
    color: var(--input-text);

    &:focus {
      outline: none;
      border-color: var(--primary);
    }
  }

  .report-confirmation {
    font-size: 0.85rem;
    color: var(--success);
  }

  .report-error {
    font-size: 0.85rem;
    color: var(--error);
  }

  .action-buttons {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }
</style>
