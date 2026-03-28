<script lang="ts">
import os from 'os';

import { defineComponent } from 'vue';
import { mapGetters, mapState } from 'vuex';

import EmptyState from '@pkg/components/EmptyState.vue';
import PreferencesBody from '@pkg/components/Preferences/ModalBody.vue';
import PreferencesFooter from '@pkg/components/Preferences/ModalFooter.vue';
import PreferencesHeader from '@pkg/components/Preferences/ModalHeader.vue';
import PreferencesNav from '@pkg/components/Preferences/ModalNav.vue';
import type { TransientSettings } from '@pkg/config/transientSettings';
import type { ServerState } from '@pkg/main/commandServer/httpCommandServer';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { Direction, RecursivePartial } from '@pkg/utils/typeUtils';
import { preferencesNavItems } from '@pkg/window/preferenceConstants';
import PostHogTracker from '@pkg/components/PostHogTracker.vue';
import { useTheme } from '@pkg/composables/useTheme';

export default defineComponent({
  name:       'preferences-modal',
  components: {
    PreferencesHeader, PreferencesNav, PreferencesBody, PreferencesFooter, EmptyState, PostHogTracker,
  },
  layout: 'preferences',
  setup() {
    // Initialize theme system so this window receives theme changes
    const { currentTheme, isDark } = useTheme();

    return { currentTheme, isDark };
  },
  data() {
    return { preferencesLoaded: false };
  },
  computed: {
    ...mapGetters('preferences', ['getPreferences', 'hasError']),
    ...mapGetters('transientSettings', ['getCurrentNavItem']),
    ...mapState('credentials', ['credentials']),
    navItems(): string[] {
      return preferencesNavItems.map(({ name }) => name);
    },
  },
  async beforeMount() {
    await this.$store.dispatch('credentials/fetchCredentials');
    await this.$store.dispatch('preferences/fetchPreferences');
    await this.$store.dispatch('preferences/fetchLocked');
    await this.$store.dispatch('transientSettings/fetchTransientSettings');
    this.preferencesLoaded = true;

    ipcRenderer.on('k8s-integrations', (_, integrations: Record<string, string | boolean>) => {
      this.$store.dispatch('preferences/setWslIntegrations', integrations);
    });

    ipcRenderer.send('k8s-integrations');

    this.$store.dispatch('preferences/setPlatformWindows', os.platform().startsWith('win'));

    ipcRenderer.on('route', async(event, args) => {
      await this.navigateToTab(args);
    });

    ipcRenderer.invoke('versions/macOs').then((macOsVersion) => {
      this.$store.dispatch('transientSettings/setMacOsVersion', macOsVersion);
    });

    ipcRenderer.invoke('host/isArm').then((isArm) => {
      this.$store.dispatch('transientSettings/setIsArm', isArm);
    });
  },
  beforeUnmount() {
    /**
     * Removing the listeners resolves the issue of receiving duplicated messages from 'route' channel.
     * Originated by: https://github.com/rancher-sandbox/rancher-desktop/issues/3232
     */
    ipcRenderer.removeAllListeners('route');
  },
  methods: {
    async navChanged(current: string) {
      await this.commitNavItem(current);
    },
    async commitNavItem(current: string) {
      await this.$store.dispatch(
        'transientSettings/commitPreferences',
        { payload: { preferences: { navItem: { current } } } },
      );
    },
    closePreferences() {
      ipcRenderer.send('preferences-close');
    },
    async applyPreferences() {
      const resetAccepted = await this.proposePreferences();

      if (!resetAccepted) {
        return;
      }

      await this.$store.dispatch('preferences/commitPreferences');
      this.closePreferences();
    },
    async proposePreferences() {
      const { reset } = await this.$store.dispatch('preferences/proposePreferences');

      if (!reset) {
        return true;
      }

      const cancelPosition = 1;

      const result = await ipcRenderer.invoke('show-message-box', {
        title:    'Sulla Desktop - Reset Kubernetes',
        type:     'warning',
        message:  'Apply preferences and reset Kubernetes?',
        detail:   'These changes will reset the Kubernetes cluster, which will result in a loss of workloads and container images.',
        cancelId: cancelPosition,
        buttons:  [
          'Apply and reset',
          'Cancel',
        ],
      });

      return result.response !== cancelPosition;
    },
    reloadPreferences() {
      window.location.reload();
    },
    async navigateToTab(args: { name?: string, direction?: Direction }) {
      const { name, direction } = args;

      if (name) {
        await this.commitNavItem(name);

        return;
      }

      if (direction) {
        const dir = (direction === 'forward' ? 1 : -1);
        const idx = (this.navItems.length + this.navItems.indexOf(this.getCurrentNavItem) + dir) % this.navItems.length;

        await this.commitNavItem(this.navItems[idx]);
      }
    },
  },
});
</script>

<template>
  <div
    v-if="preferencesLoaded"
    class="modal-grid"
    :class="{ dark: isDark }"
  >
    <preferences-header
      class="preferences-header"
    />
    <preferences-nav
      v-if="!hasError"
      class="preferences-nav"
      :current-nav-item="getCurrentNavItem"
      :nav-items="navItems"
      @nav-changed="navChanged"
    />
    <preferences-body
      v-bind="$attrs"
      class="preferences-body"
      :current-nav-item="getCurrentNavItem"
      :preferences="getPreferences"
    >
      <div
        v-if="hasError"
        class="preferences-error"
      >
        <empty-state
          icon="icon-warning"
          heading="Unable to fetch preferences"
          body="Reload Preferences to try again."
        >
          <template #primary-action>
            <button
              class="btn role-primary"
              @click="reloadPreferences"
            >
              Reload preferences
            </button>
          </template>
        </empty-state>
      </div>
    </preferences-body>
    <preferences-footer
      class="preferences-footer"
      @cancel="closePreferences"
      @apply="applyPreferences"
    />
  </div>
</template>

<style lang="scss">
  .modal .vm--modal {
    background-color: var(--body-bg);
  }

  .preferences-header {
    grid-area: header;
    height: 3rem;
    font-size: var(--fs-heading);
    line-height: 2rem;
    display: flex;
    align-items: center;
    padding: 0 0.75rem;
    width: 100%;
    border-bottom: 1px solid var(--border-default, var(--header-border));
    background: var(--bg-page, var(--body-bg));
    color: var(--text-primary, var(--body-text));

    h1 {
      flex: 1;
      margin: 0;
      font-size: inherit;
      font-weight: normal;
    }
  }

  .preferences-nav {
    grid-area: nav;
    width: 200px;
    border-right: 1px solid var(--border-default, var(--header-border));
    padding-top: 0.75rem;
    flex-shrink: 0;
    background: var(--bg-page, var(--body-bg));
  }

  .preferences-body {
    grid-area: body;
    max-height: 100%;
    overflow: auto;
    background: var(--bg-page, var(--body-bg));
    color: var(--text-primary, var(--body-text));

    h2 {
      margin: 0 0 0.5rem;
      font-size: var(--fs-heading);
      font-weight: 500;
      color: var(--text-primary, var(--body-text));
    }

    h3 {
      margin: 1.5rem 0 0.75rem;
      font-size: var(--fs-body);
      font-weight: 500;
      color: var(--text-primary, var(--body-text));
    }

    .description {
      color: var(--text-muted, var(--muted));
      margin-bottom: 1.5rem;
    }
  }

  .preferences-footer {
    grid-area: footer;
    border-top: 1px solid var(--border-default, var(--header-border));
    background: var(--bg-page, var(--body-bg));
    padding: 0.75rem 1rem;
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .modal-grid {
    height: 100vh;
    display: grid;
    grid-template-columns: 200px 1fr;
    grid-template-rows: auto 1fr auto;
    grid-template-areas:
      "header header"
      "nav body"
      "footer footer";
    background: var(--bg-page, var(--body-bg));
    color: var(--text-primary, var(--body-text));
  }

  .preferences-error {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: row;
    justify-content: center;
    align-items: center;
    padding-bottom: 6rem;
  }
</style>
