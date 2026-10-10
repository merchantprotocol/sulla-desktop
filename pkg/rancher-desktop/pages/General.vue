<template>
  <div class="general">
    <header class="general-noir-intro">
      <div class="general-noir-eyebrow">
        General
      </div>
      <h1>Sulla Desktop, ready for what comes next.</h1>
      <p>Updates, telemetry, project links, and network health in one place.</p>
    </header>
    <div>
      <ul>
        <li>Project Discussions: <b>#sulla-desktop</b> in <a href="https://github.com/merchantprotocol/sulla-desktop/discussions">Sulla Desktop</a> Github</li>
        <li class="project-links">
          <span>Project Links:</span>
          <a href="https://sulladesktop.com">Homepage</a>
          <a href="https://github.com/merchantprotocol/sulla-desktop/issues">Issues</a>
        </li>
      </ul>
    </div>
    <hr>
    <update-status
      :enabled="settings.application.updater.enabled"
      :update-state="updateState"
      :is-auto-update-locked="autoUpdateLocked"
      @enabled="onUpdateEnabled"
      @apply="onUpdateApply"
    />
    <div class="check-now-row">
      <button
        class="btn role-secondary"
        @click="onCheckNow"
      >
        Check for Updates Now
      </button>
    </div>
    <hr>
    <telemetry-opt-in
      :telemetry="settings.application.telemetry.enabled"
      :is-telemetry-locked="telemetryLocked"
      @update-telemetry="updateTelemetry"
    />
    <hr>
    <div class="network-status">
      <network-status />
    </div>
  </div>
</template>

<script>

import _ from 'lodash';

import NetworkStatus from '@pkg/components/NetworkStatus.vue';
import TelemetryOptIn from '@pkg/components/TelemetryOptIn.vue';
import UpdateStatus from '@pkg/components/UpdateStatus.vue';
import { defaultSettings } from '@pkg/config/settings';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export default {
  name:       'General',
  title:      'General',
  components: {
    NetworkStatus, TelemetryOptIn, UpdateStatus,
  },
  data() {
    return {
      settings:         defaultSettings,
      telemetryLocked:  null,
      autoUpdateLocked: null,
      /** @type import('@pkg/main/update').UpdateState | null */
      updateState:      null,
    };
  },

  mounted() {
    this.$store.dispatch(
      'page/setHeader',
      {
        title:       this.t('general.title'),
        description: this.t('general.description'),
        icon:        'icon icon-rancher-desktop',
      },
    );
    ipcRenderer.on('settings-update', this.onSettingsUpdate);
    ipcRenderer.on('update-state', this.onUpdateState);
    ipcRenderer.send('update-state');
    ipcRenderer.on('settings-read', (event, settings) => {
      this.$data.settings = settings;
    });
    ipcRenderer.send('settings-read');
    ipcRenderer.invoke('get-locked-fields').then((lockedFields) => {
      this.$data.telemetryLocked = _.get(lockedFields, 'application.telemetry.enabled');
      this.$data.autoUpdateLocked = _.get(lockedFields, 'application.updater.enabled');
    });
  },

  beforeUnmount() {
    ipcRenderer.off('settings-update', this.onSettingsUpdate);
    ipcRenderer.off('update-state', this.onUpdateState);
  },

  methods: {
    onSettingsUpdate(event, settings) {
      this.$data.settings = settings;
    },
    onUpdateEnabled(value) {
      ipcRenderer.invoke('settings-write', { application: { updater: { enabled: value } } });
    },
    onUpdateApply() {
      ipcRenderer.send('update-apply');
    },
    onCheckNow() {
      ipcRenderer.send('updater:check', 'manual');
    },
    onUpdateState(event, state) {
      this.$data.updateState = state;
    },
    updateTelemetry(value) {
      ipcRenderer.invoke('settings-write', { application: { telemetry: { enabled: value } } });
    },
  },
};
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped lang="scss">
.general {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;

  ul {
    margin-bottom: 0;

    li {
      margin-bottom: .5em;
    }
  }
}

.project-links > * {
  margin-right: .25em;
}

.general-noir-intro {
  display: none;
}

:global(.theme-noir) .general-noir-intro {
  display: block;
  margin-bottom: 10px;

  .general-noir-eyebrow {
    margin-bottom: 6px;
    color: var(--nx-accent-2);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 10.5px;
    letter-spacing: .14em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0 0 6px;
    color: var(--nx-read-1);
    font-family: 'Playfair Display', Georgia, serif;
    font-size: 30px;
    font-weight: 600;
    line-height: 1.1;
  }

  p {
    margin: 0 0 14px;
    color: var(--nx-read-3);
    font-size: 14px;
  }
}

:global(.theme-noir) .general > div:not(.general-noir-intro),
:global(.theme-noir) .general > .network-status {
  padding: 18px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--nx-hair) 43.75%, transparent);
  box-shadow: inset 0 0 0 1px var(--nx-hair);
}

:global(.theme-noir) .general > hr {
  display: none;
}
</style>
