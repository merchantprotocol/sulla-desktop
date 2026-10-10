<template>
  <div
    class="wrapper docker-dashboard-shell"
    :class="{
      blur,
      dark: isDark,
      'docker-dashboard-main': activeMainTab,
    }"
  >
    <rd-nav
      class="nav"
      :items="routes"
      :extensions="installedExtensions"
      @open-dashboard="openDashboard"
      @open-preferences="openPreferences"
    />
    <the-title ref="title" />
    <main
      ref="body"
      class="body main-preferences"
    >
      <header
        v-if="activeMainTab"
        class="docker-page-intro"
      >
        <div class="docker-page-eyebrow">
          {{ activePageCopy.eyebrow }}
        </div>
        <h1>{{ activePageCopy.headline }}</h1>
        <p>{{ activePageCopy.lead }}</p>
      </header>
      <!-- Main tabs are always mounted, toggled with v-show to preserve state -->
      <Containers v-show="activeMainTab === '/Containers'" />
      <Volumes v-show="activeMainTab === '/Volumes'" />
      <PortForwarding v-show="activeMainTab === '/PortForwarding'" />
      <Images v-show="activeMainTab === '/Images'" />
      <Snapshots v-show="activeMainTab === '/Snapshots'" />
      <Troubleshooting v-show="activeMainTab === '/Troubleshooting'" />
      <Diagnostics v-show="activeMainTab === '/Diagnostics'" />
      <!-- Non-main routes (sub-pages, dialogs, extensions) still use RouterView -->
      <RouterView v-if="!activeMainTab" />
    </main>
    <!-- The extension area is used for sizing the extension view. -->
    <div
      id="extension-spacer"
      class="extension"
    />
    <status-bar class="status-bar" />
    <!-- The ActionMenu is used by SortableTable for per-row actions. -->
    <ActionMenu data-testid="actionmenu" />
  </div>
</template>

<script>

import { mapGetters, mapState } from 'vuex';

import '../entry/agent-tailwind.css';
import ActionMenu from '@pkg/components/ActionMenu.vue';
import Nav from '@pkg/components/Nav.vue';
import StatusBar from '@pkg/components/StatusBar.vue';
import TheTitle from '@pkg/components/TheTitle.vue';
import { useTheme } from '@pkg/composables/useTheme';
import { mapTypedState } from '@pkg/entry/store';
import Containers from '@pkg/pages/Containers.vue';
import Diagnostics from '@pkg/pages/Diagnostics.vue';
import Images from '@pkg/pages/Images.vue';
import PortForwarding from '@pkg/pages/PortForwarding.vue';
import Snapshots from '@pkg/pages/Snapshots.vue';
import Troubleshooting from '@pkg/pages/Troubleshooting.vue';
import Volumes from '@pkg/pages/Volumes.vue';
import initExtensions from '@pkg/preload/extensions';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { mainRoutes } from '@pkg/window/constants';

export default {
  name:       'App',
  components: {
    StatusBar,
    ActionMenu,
    rdNav: Nav,
    TheTitle,
    Containers,
    Volumes,
    PortForwarding,
    Images,
    Snapshots,
    Troubleshooting,
    Diagnostics,
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
    routes() {
      const badges = {
        '/Diagnostics': this.diagnosticsCount,
      };

      return mainRoutes.map((route) => {
        if (route.route in badges) {
          return { ...route, error: badges[route.route] };
        }

        return route;
      });
    },
    paths() {
      return mainRoutes.map(r => r.route);
    },
    activeMainTab() {
      const currentPath = this.$route.path;

      return this.paths.find(p => currentPath.toLowerCase() === p.toLowerCase()) || null;
    },
    activePageCopy() {
      return ({
        '/Containers': {
          eyebrow: 'Containers', headline: 'Everything running, at a glance.', lead: 'Start, stop, inspect, and clean up local workloads.',
        },
        '/Volumes': {
          eyebrow: 'Volumes', headline: 'Persistent data, accounted for.', lead: 'Browse storage, inspect mount points, and remove what is no longer needed.',
        },
        '/PortForwarding': {
          eyebrow: 'Port forwarding', headline: 'Local services, within reach.', lead: 'Expose Kubernetes services on local ports and control every active forward.',
        },
        '/Images': {
          eyebrow: 'Images', headline: 'The layers behind every workload.', lead: 'Pull, scan, push, and prune the images stored by your local runtime.',
        },
        '/Snapshots': {
          eyebrow: 'Snapshots', headline: 'A safe point to return to.', lead: 'Capture the current runtime state and restore it when you need to rewind.',
        },
        '/Troubleshooting': {
          eyebrow: 'Troubleshooting', headline: 'When the engine needs attention.', lead: 'Open logs, reset Kubernetes, or return the runtime to a clean state.',
        },
        '/Diagnostics': {
          eyebrow: 'Diagnostics', headline: 'Know what is healthy, and what is not.', lead: 'Run system checks, inspect failures, and mute findings you have reviewed.',
        },
      })[this.activeMainTab] ?? { eyebrow: '', headline: '', lead: '' };
    },
    /** @returns {number} The number of diagnostics errors. */
    diagnosticsCount() {
      return this.diagnostics.filter(diagnostic => !diagnostic.mute).length;
    },
    ...mapState('credentials', ['credentials']),
    ...mapTypedState('diagnostics', ['diagnostics']),
    ...mapGetters('extensions', ['installedExtensions']),
  },

  beforeMount() {
    // The window title isn't set correctly in E2E; as a workaround, force set
    // it here again.
    document.title ||= 'Sulla Desktop';

    this.fetch().catch(ex => console.error(ex));

    initExtensions();
    ipcRenderer.on('window/blur', (event, blur) => {
      this.blur = blur;
    });
    ipcRenderer.on('backend-locked', (_event, action) => {
      ipcRenderer.send('preferences-close');
      this.showCreatingSnapshotDialog(action);
    });
    ipcRenderer.on('backend-unlocked', () => {
      ipcRenderer.send('dialog/close', { dialog: 'SnapshotsDialog', snapshotEventType: 'backend-lock' });
    });

    ipcRenderer.send('backend-state-check');

    ipcRenderer.on('k8s-check-state', (event, state) => {
      this.$store.dispatch('k8sManager/setK8sState', state);
    });
    ipcRenderer.on('route', (event, args) => {
      this.goToRoute(args);
    });
    ipcRenderer.on('extensions/changed', () => {
      this.$store.dispatch('extensions/fetch');
    });
    this.$store.dispatch('extensions/fetch');

    ipcRenderer.on('preferences/changed', () => {
      this.$store.dispatch('preferences/fetchPreferences');
    });

    ipcRenderer.on('extensions/getContentArea', () => {
      /** @type {DOMRect} */
      const titleRect = this.$refs.title.$el.getBoundingClientRect();
      /** @type {DOMRect} */
      const bodyRect = this.$refs.body.getBoundingClientRect();
      const payload = {
        top:    titleRect.top,
        right:  titleRect.right,
        bottom: bodyRect.bottom,
        left:   titleRect.left,
      };

      ipcRenderer.send('ok:extensions/getContentArea', payload);
    });
  },

  mounted() {
    this.$store.dispatch('credentials/fetchCredentials').catch(console.error);
    this.$store.dispatch('i18n/init').catch(ex => console.error(ex));
  },

  beforeUnmount() {
    ipcRenderer.off('k8s-check-state');
    ipcRenderer.off('extensions/getContentArea');
    ipcRenderer.removeAllListeners('backend-locked');
    ipcRenderer.removeAllListeners('backend-unlocked');
    ipcRenderer.removeAllListeners('window/blur');
  },

  methods: {
    async fetch() {
      await this.$store.dispatch('credentials/fetchCredentials');
      if (!this.credentials.port || !this.credentials.user || !this.credentials.password) {
        console.log(`Credentials aren't ready for getting diagnostics -- will try later`);

        return;
      }
      await this.$store.dispatch('preferences/fetchPreferences');
      await this.$store.dispatch('diagnostics/fetchDiagnostics');
    },

    openDashboard() {
      ipcRenderer.send('dashboard-open');
    },
    openPreferences() {
      ipcRenderer.send('preferences-open');
    },
    goToRoute(args) {
      const { path, direction } = args;

      if (path) {
        this.$router.push({ path });

        return;
      }

      if (direction) {
        const dir = (direction === 'forward' ? 1 : -1);
        const idx = (this.paths.length + this.paths.indexOf(this.$router.currentRoute.path) + dir) % this.paths.length;

        this.$router.push({ path: this.paths[idx] });
      }
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
    "nav        title"
    "nav        body"    1fr
    "status-bar status-bar"
    / var(--nav-width) 1fr;
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

  .nav {
    grid-area: nav;
    border-right: var(--nav-border-size) solid var(--nav-border);
    background: var(--nav-bg, var(--body-bg));
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

  .extension {
    grid-area: title / title / body / body;
    z-index: -1000;
  }

  .status-bar {
    grid-area: status-bar;
    border-top: 1px solid var(--header-border);
    background: var(--status-bar-bg, var(--body-bg));
  }
}
</style>
<style lang="scss">
.docker-page-intro {
  display: none;
}

.theme-noir-dark .docker-dashboard-shell {
  --docker-hairline: rgba(168, 192, 220, 0.08);
  --docker-steel: #5096b3;
  --docker-steel-bright: #6ab0cc;
  --docker-read: #f3f5f8;
  --docker-read-soft: #a9b3c1;
  --docker-read-dim: #7a8291;
  grid-template:
    "nav        title"
    "nav        body" 1fr
    "status-bar status-bar"
    / 230px 1fr;
  background: radial-gradient(110% 60% at 0% 0%, rgba(80, 150, 179, 0.12), transparent 55%), #070d1a;

  > .title {
    min-height: 52px;
    padding: 10px 34px;
    border-color: var(--docker-hairline);
    background: rgba(3, 6, 12, 0.28);

    .title-top {
      justify-content: flex-end;
    }

    h1 {
      color: var(--docker-read);
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 24px;
      font-weight: 600;
    }
  }

  &.docker-dashboard-main > .title {
    h1,
    .description {
      display: none;
    }
  }

  > .body {
    padding: 0 34px 30px;
    background: transparent;
    scrollbar-width: thin;
    scrollbar-color: rgba(168, 192, 220, 0.15) transparent;
  }

  .main-preferences > div {
    padding-top: 0;
    animation: docker-noir-enter .48s cubic-bezier(.22, 1, .36, 1) both;
  }

  .docker-page-intro {
    display: block;
    flex: none;
    padding: 28px 0 24px;
    animation: docker-noir-enter .48s cubic-bezier(.22, 1, .36, 1) both;

    .docker-page-eyebrow {
      margin-bottom: 6px;
      color: var(--docker-steel-bright);
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      font-size: 10.5px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0 0 6px;
      color: var(--docker-read);
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 30px;
      font-weight: 600;
      letter-spacing: -0.02em;
      line-height: 1.1;
    }

    p {
      margin: 0;
      color: var(--docker-read-soft);
      font-size: 14px;
    }
  }

  .sortable-table-header {
    margin-bottom: 4px;
  }

  .fixed-header-actions {
    align-items: end;
    padding-bottom: 14px;
  }

  .search-box,
  select,
  input[type="number"] {
    min-height: 40px;
    border: 1px solid rgba(168, 192, 220, 0.12);
    border-radius: 12px;
    color: var(--docker-read);
    background: rgba(3, 6, 12, 0.6);
    box-shadow: none;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  }

  table.sortable-table {
    border-collapse: separate;
    border-spacing: 0 6px;
    overflow: visible;
    outline: 0;
    background: transparent;

    thead th {
      padding: 0 12px 6px;
      border: 0;
      color: var(--docker-read-dim);
      background: transparent;
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    tbody tr.main-row,
    tbody tr:not(.group-row):not(.no-rows):not(.no-results) {
      height: 44px;
      border: 0;
      color: #dee4ec;
      background: rgba(168, 192, 220, 0.035);
      box-shadow: inset 0 0 0 1px var(--docker-hairline);
      transition: background .16s, box-shadow .2s, transform .3s cubic-bezier(.22, 1, .36, 1);

      &:hover {
        background: rgba(80, 150, 179, 0.08);
        box-shadow: inset 0 0 0 1px rgba(106, 176, 204, 0.2);
        transform: translateX(2px);

        .actions,
        .action-div {
          opacity: 1;
        }
      }

      .actions,
      .action-div {
        opacity: 0.2;
        transition: opacity .16s;
      }

      td {
        padding: 9px 12px;
        border: 0;

        &:first-child {
          border-radius: 12px 0 0 12px;
        }

        &:last-child {
          border-radius: 0 12px 12px 0;
        }
      }
    }

    tbody tr.group-row {
      background: transparent;

      .group-tab {
        color: var(--docker-read-soft);
        background: transparent;
        font-family: ui-monospace, 'SF Mono', Menlo, monospace;
        font-size: 11px;
        letter-spacing: 0.06em;
        text-transform: uppercase;

        &::after {
          display: none;
        }
      }
    }

    tbody .no-rows td,
    tbody .no-results td {
      padding: 46px 20px;
      border-radius: 18px;
      color: var(--docker-read-soft);
      background: rgba(168, 192, 220, 0.025);
      box-shadow: inset 0 0 0 1px var(--docker-hairline);
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 20px;
    }

    td:nth-child(n+2) code,
    td:nth-child(n+2) .port-container,
    td[data-testid*="mountpoint"],
    td[data-testid*="driver"],
    td[data-testid*="name"] {
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      font-size: 11.5px;
    }
  }

  .paging {
    color: var(--docker-read-dim);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px;
  }

  .btn {
    border-radius: 16px;
  }

  .btn.role-primary {
    border-color: rgba(106, 176, 204, 0.5);
    background: linear-gradient(180deg, #6ab0cc, #5096b3);
    box-shadow: 0 0 16px rgba(80, 150, 179, 0.22);
  }

  .containersTable .port-container,
  .imagesTable td:nth-child(3),
  .imagesTable td:nth-child(4),
  .listen-port-p {
    color: #a8c0dc;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  }

  .badge-state {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 10px;
  }

  .troubleshooting-items,
  .snapshots .cards,
  .general {
    gap: 14px;
  }

  .troubleshooting-items > *,
  .snapshots .cards > div,
  .general > div,
  .diagnostics > .status {
    border-radius: 18px;
    background: rgba(168, 192, 220, 0.035);
    box-shadow: inset 0 0 0 1px var(--docker-hairline);
  }

  .snapshots .cards > div {
    overflow: hidden;
  }

  .snapshots .cards .empty-state-container {
    min-height: 180px;
    display: grid;
    place-items: center;
  }

  .snapshot-card,
  .card-container,
  .scanning-results,
  .container-info,
  .volume-files {
    border-color: var(--docker-hairline);
    border-radius: 18px;
    background: rgba(168, 192, 220, 0.035);
    box-shadow: inset 0 0 0 1px var(--docker-hairline);
  }

  .troubleshooting-items > * {
    margin-bottom: 12px;
    padding: 18px;
  }

  .troubleshooting .text-xl {
    color: var(--docker-read);
    font-size: 14px;
    font-weight: 600;
  }

  .diagnostics > .status {
    padding: 18px;
  }

  .diagnostics .item-results::first-letter {
    color: #f85149;
  }

  .status-bar {
    border-color: var(--docker-hairline);
    background: rgba(3, 6, 12, 0.75);
  }
}

@keyframes docker-noir-enter {
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

@media (prefers-reduced-motion: reduce) {
  .theme-noir-dark .docker-dashboard-shell {
    .main-preferences > div,
    .docker-page-intro,
    table.sortable-table tbody tr {
      animation: none;
      transition: none;
    }
  }
}
</style>
