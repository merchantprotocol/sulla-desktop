<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!--
  Sulla Desktop · https://sulladesktop.com
  Portions Copyright SUSE LLC and the Rancher Desktop contributors, licensed under
  the Apache License 2.0 (LICENSES/Apache-2.0.txt).
  Modifications Copyright (c) 2025-2026 Merchant Protocol LLC, licensed under the
  GPL-2.0-or-later (LICENSE).
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div
    class="wrapper"
    :class="{
      blur,
      dark: isDark,
    }"
  >
    <the-title ref="title" />
    <NoAiConnectedBanner />
    <main
      ref="body"
      class="body"
    >
      <RouterView />
    </main>
    <status-bar class="status-bar" />
    <!-- The ActionMenu is used by SortableTable for per-row actions. -->
    <ActionMenu data-testid="actionmenu" />
  </div>
</template>

<script>

import { mapState } from 'vuex';

import '../entry/agent-tailwind.css';
import ActionMenu from '@pkg/components/ActionMenu.vue';
import NoAiConnectedBanner from '@pkg/components/NoAiConnectedBanner.vue';
import StatusBar from '@pkg/components/StatusBar.vue';
import TheTitle from '@pkg/components/TheTitle.vue';
import { useTheme } from '@pkg/composables/useTheme';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export default {
  name:       'App',
  components: {
    StatusBar,
    ActionMenu,
    TheTitle,
    NoAiConnectedBanner,
  },

  setup() {
    // Initialize theme system so this window receives theme changes
    const { currentTheme, isDark } = useTheme();

    return { currentTheme, isDark };
  },

  data() {
    return { blur: false };
  },

  computed: {
    ...mapState('credentials', ['credentials']),
  },

  beforeMount() {
    // The window title isn't set correctly in E2E; as a workaround, force set
    // it here again.
    document.title ||= 'Sulla Desktop';

    this.fetch().catch(ex => console.error(ex));

    ipcRenderer.on('window/blur', (event, blur) => {
      this.blur = blur;
    });
    ipcRenderer.on('backend-locked', (_event, action) => {
      this.showCreatingSnapshotDialog(action);
    });
    ipcRenderer.on('backend-unlocked', () => {
      ipcRenderer.send('dialog/close', { dialog: 'SnapshotsDialog', snapshotEventType: 'backend-lock' });
    });

    ipcRenderer.send('backend-state-check');

    ipcRenderer.on('k8s-check-state', (event, state) => {
      this.$store.dispatch('k8sManager/setK8sState', state);
    });
    ipcRenderer.on('preferences/changed', () => {
      this.$store.dispatch('preferences/fetchPreferences');
    });
  },

  mounted() {
    this.$store.dispatch('credentials/fetchCredentials').catch(console.error);
    this.$store.dispatch('i18n/init').catch(ex => console.error(ex));
  },

  beforeUnmount() {
    ipcRenderer.off('k8s-check-state');
    ipcRenderer.removeAllListeners('backend-locked');
    ipcRenderer.removeAllListeners('backend-unlocked');
    ipcRenderer.removeAllListeners('window/blur');
  },

  methods: {
    async fetch() {
      await this.$store.dispatch('credentials/fetchCredentials');
      if (!this.credentials.port || !this.credentials.user || !this.credentials.password) {
        console.log(`Backend credentials aren't ready -- will try later`);

        return;
      }
      await this.$store.dispatch('preferences/fetchPreferences');
    },

    showCreatingSnapshotDialog(action) {
      ipcRenderer.invoke(
        'show-snapshots-blocking-dialog',
        {
          window: {
            buttons:  [],
            cancelId: 1,
          },
          format: {
            header:            action || this.t('snapshots.dialog.generic.header', {}, true),
            /** TODO: put here operation type information from 'state' */
            message:           this.t('snapshots.dialog.generic.message', {}, true),
            showProgressBar:   true,
            snapshotEventType: 'backend-lock',
          },
        },
      );
    },
  },
};
</script>

<style lang="scss" src="@pkg/assets/styles/app.scss"></style>
<style lang="scss" scoped>
.wrapper {
  display: grid;
  grid-template:
    "title"
    "no-ai"
    "body"    1fr
    "status-bar";
  background-color: var(--body-bg);
  color: var(--body-text);
  width: 100vw;
  height: 100vh;

  &.blur {
   opacity: 0.2;
  }

  .header {
    grid-area: header;
    border-bottom: var(--header-border-size) solid var(--header-border);
  }

  .title {
    grid-area: title;
    border-bottom: 1px solid var(--header-border);
    background: var(--title-bg, var(--body-bg));
  }

  .body {
    grid-area: body;
    display: flex;
    flex-direction: column;
    padding: 0 20px 20px 20px;
    overflow: auto;
    background: var(--body-bg);
  }

  .main-preferences > div {
    padding-top: 15px;
  }

  .status-bar {
    grid-area: status-bar;
    border-top: 1px solid var(--header-border);
    background: var(--status-bar-bg, var(--body-bg));
  }
}
</style>
