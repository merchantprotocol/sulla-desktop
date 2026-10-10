<script lang="ts">
import os from 'os';

import { defineComponent } from 'vue';
import { mapGetters, mapState } from 'vuex';

import EmptyState from '@pkg/components/EmptyState.vue';
import PreferencesBody from '@pkg/components/Preferences/ModalBody.vue';
import PreferencesFooter from '@pkg/components/Preferences/ModalFooter.vue';
import PreferencesHeader from '@pkg/components/Preferences/ModalHeader.vue';
import PreferencesNav from '@pkg/components/Preferences/ModalNav.vue';
import { useTheme } from '@pkg/composables/useTheme';
import type { TransientSettings } from '@pkg/config/transientSettings';
import type { ServerState } from '@pkg/main/commandServer/httpCommandServer';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { Direction, RecursivePartial } from '@pkg/utils/typeUtils';
import { preferencesNavItems } from '@pkg/window/preferenceConstants';

export default defineComponent({
  name:       'preferences-modal',
  components: {
    PreferencesHeader, PreferencesNav, PreferencesBody, PreferencesFooter, EmptyState,
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

  @keyframes preferences-noir-pane-in {
    from {
      opacity: 0;
      transform: translateY(8px);
      filter: blur(8px);
    }

    to {
      opacity: 1;
      transform: none;
      filter: none;
    }
  }

  .theme-noir-dark {
    .modal-grid {
      --preferences-noir-spring: linear(0, .0258, .09, .1763, .2732, .3724, .4683, .5573, .6376, .7082, .7689, .8202, .8628, .8976, .9256, .9476, .9648, .9778, .9875, .9945, .9994, 1.0026, 1.0047, 1.0058, 1.0062, 1.0062, 1.0059, 1.0055, 1.0049, 1.0043, 1.0036, 1.0031, 1.0025, 1.002, 1.0016, 1.0013, 1);
      position: relative;
      isolation: isolate;
      grid-template-columns: 230px minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr) auto;
      grid-template-areas:
        "header body"
        "nav body"
        "nav footer";
      overflow: hidden;
      background:
        radial-gradient(110% 60% at 0% 0%, rgba(80, 150, 179, 0.12), transparent 55%),
        #070d1a;
      color: #dee4ec;
      box-shadow: inset 0 0 0 1px rgba(168, 192, 220, 0.1);
    }

    .preferences-header {
      z-index: 1;
      height: auto;
      min-height: 92px;
      padding: 24px 20px 14px;
      flex-direction: column;
      align-items: flex-start;
      justify-content: flex-end;
      border: 0;
      border-right: 1px solid rgba(168, 192, 220, 0.08);
      background: rgba(3, 6, 12, 0.6);

      .title {
        flex: none;
        font-family: 'Playfair Display', Georgia, serif;
        font-size: 21px;
        font-weight: 600;
        line-height: 1.2;
        letter-spacing: -0.01em;
        color: #f3f5f8;
      }

      .preferences-noir-subtitle {
        display: block;
        margin-top: 5px;
        font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
        font-size: 10.5px;
        line-height: 1.3;
        letter-spacing: 0.04em;
        color: #7a8291;
      }
    }

    .preferences-nav {
      z-index: 1;
      grid-row: 2 / 4;
      width: 230px;
      min-height: 0;
      padding: 0 12px 18px;
      border: 0;
      border-right: 1px solid rgba(168, 192, 220, 0.08);
      background: rgba(3, 6, 12, 0.6);
    }

    .preferences-nav-list {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .preferences-nav-glass {
      position: absolute;
      inset: 0 0 auto;
      display: block;
      height: 40px;
      border-radius: 20px;
      pointer-events: none;
      background: linear-gradient(180deg, rgba(80, 150, 179, 0.28), rgba(80, 150, 179, 0.12));
      box-shadow:
        inset 0 0 0 0.5px rgba(106, 176, 204, 0.5),
        0 0 20px rgba(80, 150, 179, 0.2);
      transition: transform 0.58s var(--preferences-noir-spring);

      &::before {
        content: '';
        position: absolute;
        top: 9px;
        left: -12px;
        width: 3px;
        height: 22px;
        border-radius: 0 3px 3px 0;
        background: #6ab0cc;
        box-shadow: 0 0 10px #6ab0cc;
      }
    }

    .preferences-nav-item {
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 11px;
      height: 40px;
      min-height: 40px;
      padding: 0 14px;
      border: 0;
      border-radius: 20px;
      font-size: 13.5px;
      font-weight: 500;
      line-height: 40px;
      color: #a9b3c1;
      background: transparent;
      transition:
        color 0.16s,
        background 0.16s,
        transform 0.45s var(--preferences-noir-spring);

      &:hover {
        color: #dee4ec;
        background: rgba(80, 150, 179, 0.08);
      }

      &:active {
        transform: scale(0.96);
      }

      &.active {
        border: 0;
        color: #f3f5f8;
        background: transparent;
        font-weight: 500;
      }

      .preferences-noir-glyph {
        display: inline-block;
        width: 18px;
        font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
        font-size: 13px;
        line-height: 1;
        text-align: center;
        opacity: 0.85;
      }
    }

    .preferences-nav-status {
      display: block;
      margin-top: auto;
      padding: 12px 10px;
      border-radius: 14px;
      font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
      font-size: 10.5px;
      line-height: 1.7;
      color: #7a8291;
      background: rgba(168, 192, 220, 0.035);
      box-shadow: inset 0 0 0 1px rgba(168, 192, 220, 0.07);

      div {
        color: #a9b3c1;
      }

      span {
        display: inline-block;
        width: 7px;
        height: 7px;
        margin-right: 6px;
        border-radius: 50%;
        background: #3fb950;
        box-shadow: 0 0 8px rgba(63, 185, 80, 0.7);
      }

      small {
        font: inherit;
        color: #7a8291;
      }
    }

    .preferences-body {
      min-width: 0;
      padding: 30px 34px;
      color: #dee4ec;
      background: transparent;
      scrollbar-width: thin;
      scrollbar-color: rgba(168, 192, 220, 0.15) transparent;

      > .preferences-noir-intro {
        display: block;
        flex: none;
        animation: preferences-noir-pane-in 0.48s cubic-bezier(.22, 1, .36, 1) both;

        .preferences-noir-eyebrow {
          margin-bottom: 6px;
          font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
          font-size: 10.5px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: #6ab0cc;
        }

        h1 {
          margin: 0 0 6px;
          font-family: 'Playfair Display', Georgia, serif;
          font-size: 30px;
          font-weight: 600;
          line-height: 1.1;
          letter-spacing: -0.015em;
          color: #f3f5f8;
        }

        p {
          margin: 0 0 24px;
          font-size: 14px;
          color: #a9b3c1;
        }
      }

      > .action-tabs,
      > .appearance-content,
      > .preferences-body {
        animation: preferences-noir-pane-in 0.48s cubic-bezier(.22, 1, .36, 1) both;
      }

      .application-content,
      .virtual-machine-content,
      .container-engine-content,
      .wsl-content,
      .appearance-content,
      > .preferences-body {
        padding: 0;
      }

      .application-content,
      .virtual-machine-content,
      .container-engine-content,
      .wsl-content {
        padding-top: 18px;
      }

      .action-tabs {
        min-height: 0;
        max-height: none;
      }

      .action-tabs .tabs.horizontal {
        align-self: flex-start;
        gap: 2px;
        width: auto;
        padding: 4px;
        border: 0;
        border-radius: 16px;
        background: rgba(3, 6, 12, 0.6);
        box-shadow: inset 0 0 0 1px rgba(168, 192, 220, 0.1);
      }

      .action-tabs li.tab {
        margin: 0;
        padding: 0;
        border: 0;
        border-radius: 12px;
        background: transparent;

        a {
          display: grid;
          place-items: center;
          height: 30px;
          padding: 0 14px;
          border-radius: 12px;
          font-size: 12.5px;
          font-weight: 500;
          color: #7a8291;
          transition:
            color 0.2s,
            background 0.3s cubic-bezier(.22, 1, .36, 1),
            box-shadow 0.3s;
        }

        &:hover a {
          color: #dee4ec;
        }

        &.active a {
          color: #f3f5f8;
          background: linear-gradient(180deg, rgba(80, 150, 179, 0.32), rgba(80, 150, 179, 0.16));
          box-shadow:
            inset 0 0 0 0.5px rgba(106, 176, 204, 0.55),
            0 0 14px rgba(80, 150, 179, 0.25);
        }
      }

      .action-tabs .tab-container.no-content {
        max-height: none;
        overflow: visible;
      }

      .application-general,
      .application-behavior,
      .container-engine-general,
      .container-engine-allowed-images,
      .wsl-proxy,
      > .preferences-body {
        gap: 14px;
      }

      .rd-fieldset,
      .appearance-content,
      .system-preferences,
      .mount-type-selector > .row,
      .virtual-machine-emulation > .row,
      .wsl-integrations {
        padding: 18px;
        border-radius: 18px;
        background: rgba(168, 192, 220, 0.035);
        box-shadow: inset 0 0 0 1px rgba(168, 192, 220, 0.08);
      }

      .rd-fieldset .rd-fieldset {
        padding: 0;
        border-radius: 0;
        background: transparent;
        box-shadow: none;
      }

      .rd-fieldset legend {
        padding-bottom: 10px;
        font-size: 14px;
        font-weight: 600;
        color: #f3f5f8;
      }

      .rd-checkbox-container,
      .checkbox-outer-container-description,
      .description {
        color: #a9b3c1;
      }

      .rd-checkbox-container + .rd-checkbox-container {
        margin-top: 9px;
      }

      .rd-checkbox-container .checkbox-container {
        display: flex;
        justify-content: space-between;
        gap: 14px;
        width: 100%;
        min-height: 30px;

        .checkbox-label {
          order: -1;
          margin: 0;
          color: #dee4ec;
        }

        .checkbox-custom {
          position: relative;
          width: 46px;
          min-width: 46px;
          height: 26px;
          border: 0;
          border-radius: 13px;
          background: rgba(168, 192, 220, 0.12);
          box-shadow: inset 0 0 0 1px rgba(168, 192, 220, 0.14);
          transition:
            background 0.3s cubic-bezier(.22, 1, .36, 1),
            box-shadow 0.3s;

          &::after {
            top: 3px;
            left: 3px;
            width: 20px;
            height: 20px;
            border: 0;
            border-radius: 50%;
            opacity: 1;
            background: #dee4ec;
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
            transform: none;
            transition:
              transform 0.58s var(--preferences-noir-spring),
              background 0.2s;
          }
        }

        input:checked ~ .checkbox-custom {
          border: 0;
          background: linear-gradient(180deg, #6ab0cc, #5096b3);
          box-shadow: 0 0 14px rgba(80, 150, 179, 0.45);

          &::after {
            top: 3px;
            left: 3px;
            width: 20px;
            height: 20px;
            border: 0;
            border-radius: 50%;
            background: #fff;
            transform: translateX(20px);
          }
        }

        &.disabled {
          opacity: 0.4;
        }
      }

      input:not([type='checkbox']):not([type='radio']),
      select,
      textarea,
      .string-list-box {
        min-height: 40px;
        border: 0;
        border-radius: 12px;
        color: #f3f5f8;
        background: rgba(3, 6, 12, 0.6);
        box-shadow: inset 0 0 0 1px rgba(168, 192, 220, 0.12);
      }

      input:not([type='checkbox']):not([type='radio']):focus,
      select:focus,
      textarea:focus {
        outline: none;
        box-shadow:
          inset 0 0 0 1px rgba(106, 176, 204, 0.65),
          0 0 16px rgba(80, 150, 179, 0.18);
      }

      input:disabled,
      select:disabled,
      textarea:disabled,
      .readonly {
        opacity: 0.4;
      }

      .radio-group > div > .radio-container {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        width: 100%;
        margin: 0 0 6px;
        padding: 10px 12px;
        border-radius: 12px;
        color: #dee4ec;
        background: rgba(3, 6, 12, 0.4);
        box-shadow: inset 0 0 0 1px rgba(168, 192, 220, 0.06);
        transition:
          background 0.16s,
          box-shadow 0.2s,
          transform 0.45s var(--preferences-noir-spring);

        &:hover {
          background: rgba(80, 150, 179, 0.08);
          transform: translateX(2px);
        }

        &:has(input:checked) {
          background: rgba(80, 150, 179, 0.12);
          box-shadow: inset 0 0 0 1px rgba(106, 176, 204, 0.4);
        }

        .radio-custom {
          width: 16px;
          min-width: 16px;
          height: 16px;
          min-height: 16px;
          margin-top: 2px;
          border: 1.5px solid #484f5a;
          background: transparent;
        }

        .radio-custom[aria-checked='true'] {
          border-color: #6ab0cc;
          background: #6ab0cc;
          box-shadow:
            inset 0 0 0 4px #03060c,
            0 0 8px #6ab0cc;
        }

        .labeling {
          margin: 0;
        }

        .radio-label {
          color: #dee4ec;
        }

        .radio-button-outer-container-description {
          color: #7a8291;
        }
      }

      hr {
        border-color: rgba(168, 192, 220, 0.08);
      }

      .help {
        right: 18px;
        bottom: 14px;
      }
    }

    .preferences-footer {
      z-index: 2;
      min-height: 66px;
      padding: 14px 34px;
      border: 0;
      border-top: 1px solid rgba(168, 192, 220, 0.08);
      align-items: center;
      gap: 12px;
      background: rgba(3, 6, 12, 0.92);
      box-shadow: 0 -18px 32px rgba(3, 6, 12, 0.42);

      .preferences-noir-save-note {
        display: block;
        flex: none;
        font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
        font-size: 11px;
        color: #7a8291;
      }

      .preferences-alert {
        min-width: 0;
        height: auto;
        padding: 0;

        .alert-text {
          color: #e3b341;
        }
      }

      .preferences-actions {
        flex: none;
        gap: 8px;

        .btn {
          height: 34px;
          min-width: 82px;
          padding: 0 16px;
          border-radius: 17px;
          font-size: 12.5px;
          font-weight: 500;
          transition:
            transform 0.45s var(--preferences-noir-spring),
            opacity 0.2s;

          &:active {
            transform: scale(0.94);
          }
        }

        .role-secondary {
          border: 0;
          color: #dee4ec;
          background: transparent;
          box-shadow: inset 0 0 0 1px rgba(168, 192, 220, 0.16);
        }

        .role-primary {
          border: 0;
          color: #fff;
          background: linear-gradient(180deg, #6ab0cc, #5096b3);
          box-shadow: 0 0 16px rgba(80, 150, 179, 0.4);

          &:disabled {
            opacity: 0.4;
            box-shadow: none;
          }
        }
      }
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .theme-noir-dark {
      .preferences-nav-glass,
      .preferences-nav-item,
      .preferences-body > .preferences-noir-intro,
      .preferences-body > .action-tabs,
      .preferences-body > .appearance-content,
      .preferences-body > .preferences-body,
      .preferences-body .radio-group > div > .radio-container,
      .preferences-body .checkbox-custom,
      .preferences-body .checkbox-custom::after,
      .preferences-footer .btn {
        animation: none;
        transition: none;
      }
    }
  }
</style>
