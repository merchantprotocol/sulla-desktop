<template>
  <nav class="docker-nav">
    <div class="docker-nav-heading">
      <div class="docker-nav-title">
        Docker
      </div>
      <div class="docker-nav-subtitle">
        Containers and local runtime
      </div>
    </div>
    <ul
      ref="routeList"
      class="docker-nav-routes"
    >
      <li
        class="docker-nav-indicator"
        aria-hidden="true"
        :style="indicatorStyle"
      />
      <li
        v-for="item in items"
        :key="item.route"
        :item="item.route"
      >
        <RouterLink
          :ref="el => setRouteLink(item.route, el)"
          :class="{ 'rd-link-active': isRouteActive(item.route) }"
          :to="item.route"
        >
          <span
            class="docker-nav-glyph"
            aria-hidden="true"
          >{{ routeGlyph(item.route) }}</span>
          {{ routes[item.route].name }}
          <badge-state
            v-if="item.error"
            color="bg-error"
            class="nav-badge"
            :label="item.error.toString()"
          />
          <i
            v-if="item.experimental"
            v-tooltip="{
              content: t('prefs.experimental', undefined, true),
              placement: 'right',
            }"
            :class="`icon icon-flask`"
          />
        </RouterLink>
      </li>
    </ul>
    <hr v-if="extensionsWithUI.length">
    <div class="nav-extensions">
      <RouterLink
        v-for="extension in extensionsWithUI"
        :key="extension.id"
        :data-test="`extension-nav-${extension.metadata.ui['dashboard-tab'].title.toLowerCase()}`"
        :to="extensionRoute(extension)"
      >
        <nav-item :id="`extension:${extension.id}`">
          <template #before>
            <nav-icon-extension :extension-id="extension.id" />
          </template>
          {{ extension.metadata.ui['dashboard-tab'].title }}
        </nav-item>
      </RouterLink>
    </div>
    <div class="nav-button-container">
      <dashboard-button
        data-testid="dashboard-button"
        class="nav-button"
        @open-dashboard="openDashboard"
      />
      <preferences-button
        data-testid="preferences-button"
        class="nav-button"
        @open-preferences="openPreferences"
      />
    </div>
  </nav>
</template>

<script lang="ts">
import os from 'os';

import { BadgeState } from '@rancher/components';
import { PropType, defineComponent } from 'vue';
import { RouteRecordPublic } from 'vue-router';

import NavIconExtension from './NavIconExtension.vue';
import NavItem from './NavItem.vue';

import DashboardButton from '@pkg/components/DashboardOpen.vue';
import PreferencesButton from '@pkg/components/Preferences/ButtonOpen.vue';
import router from '@pkg/entry/router';
import type { ExtensionState } from '@pkg/store/extensions';
import { hexEncode } from '@pkg/utils/string-encode';

type ExtensionWithUI = ExtensionState & {
  metadata: { ui: { 'dashboard-tab': { title: string } } };
};

export default defineComponent({
  name:       'Nav',
  components: {
    BadgeState,
    NavItem,
    NavIconExtension,
    DashboardButton,
    PreferencesButton,
  },
  props: {
    items: {
      type:      Array as PropType<{ route: string; error?: number; experimental?: boolean }[]>,
      required:  true,
      validator: (value: { route: string, error?: number }[]) => {
        const routes = router.getRoutes().reduce((paths: Record<string, RouteRecordPublic>, route) => {
          paths[route.path] = route;

          return paths;
        }, {});

        return value && (value.length > 0) && value.every(({ route }) => {
          const result = route in routes;

          if (!result) {
            console.error(`<Nav> error: path ${ JSON.stringify(route) } not found in routes ${ JSON.stringify(Object.keys(routes)) }`);
          }

          return result;
        });
      },
    },
    extensions: {
      type:     Array as PropType<ExtensionState[]>,
      required: true,
    },
  },
  data() {
    return {
      // Generate a route (path) to route entry mapping, so that we can pick out
      // their names based on the paths given.
      routes: this.$router.getRoutes().reduce((paths: Record<string, RouteRecordPublic>, route) => {
        paths[route.path] = route;
        if (route.name === 'Supporting Utilities' && os.platform() === 'win32') {
          route.name = 'WSL Integrations';
        }

        return paths;
      }, {}),
      indicatorStyle: { transform: 'translateY(0px)', height: '40px', opacity: '0' },
      routeLinks:     {} as Record<string, any>,
    };
  },
  computed: {
    extensionsWithUI(): ExtensionWithUI[] {
      function hasUI(ext: ExtensionState): ext is ExtensionWithUI {
        return !!ext.metadata.ui?.['dashboard-tab']?.title;
      }

      return this.extensions.filter<ExtensionWithUI>(hasUI);
    },
  },
  methods: {
    setRouteLink(route: string, element: any) {
      if (element) {
        this.routeLinks[route] = element;
      }
    },
    routeGlyph(route: string): string {
      return ({
        '/Containers':      '▣',
        '/Volumes':         '◫',
        '/PortForwarding':  '↗',
        '/Images':          '◇',
        '/Snapshots':       '◷',
        '/Troubleshooting': '⌁',
        '/Diagnostics':     '◎',
      } as Record<string, string>)[route] ?? '·';
    },
    updateIndicator() {
      this.$nextTick(() => {
        const active = this.items.find(item => this.isRouteActive(item.route));
        const list = this.$refs.routeList as HTMLElement | undefined;
        const link = active ? this.routeLinks[active.route]?.$el ?? this.routeLinks[active.route] : null;

        if (!list || !(link instanceof HTMLElement)) {
          this.indicatorStyle = { ...this.indicatorStyle, opacity: '0' };
          return;
        }

        const listRect = list.getBoundingClientRect();
        const linkRect = link.getBoundingClientRect();

        this.indicatorStyle = {
          transform: `translateY(${ linkRect.top - listRect.top }px)`,
          height:    `${ linkRect.height }px`,
          opacity:   '1',
        };
      });
    },
    extensionRoute({ id, metadata }: { id: string, metadata: any }) {
      const { ui: { 'dashboard-tab': { root, src } } } = metadata;

      return {
        name:   'rdx-root-src-id',
        params: {
          root,
          src,
          id: hexEncode(id),
        },
      };
    },
    isRouteActive(route: string): boolean {
      // It is needed e.g. for sub-route /images/add not matching /Images
      // Prevents the parent item "Extensions" to be shown as active if an extension child (e.g. Epinio, Logs Explorer,
      // ...) is selected.
      if (this.$route.name === 'rdx-root-src-id') {
        return false;
      }

      return this.$route.path.toLowerCase().startsWith(route.toLowerCase());
    },
    openPreferences(): void {
      this.$emit('open-preferences');
    },
    openDashboard(): void {
      this.$emit('open-dashboard');
    },
  },
  mounted() {
    this.updateIndicator();
    window.addEventListener('resize', this.updateIndicator);
  },
  beforeUnmount() {
    window.removeEventListener('resize', this.updateIndicator);
  },
  watch: {
    '$route.path': {
      handler() {
        this.updateIndicator();
      },
      flush: 'post',
    },
  },
});
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style scoped lang="scss">
nav {
    background-color: var(--nav-bg);
    padding: 0;
    margin: 0;
    padding: 20px 0;
    display: flex;
    flex-direction: column;

    a {
      text-decoration: none;
    }

    .nav-extensions {
      overflow: auto;
      flex-grow: 1
    }
}

ul {
    margin: 0;
    padding: 0;
    list-style-type: none;

    li {
        padding: 0;

        a {
            display: flex;
            align-items: center;
            gap: 0.25rem;
            color: var(--body-text);
            text-decoration: none;
            font-size: var(--fs-heading);
            line-height: 1.75rem;
            padding: 0.5rem 0.75rem;
            outline: none;
        }

        a:is(.router-link-active, .rd-link-active) {
            background-color: var(--nav-active);
        }
    }
}

a {
  &:hover {
    text-decoration: none;
  }

  &:is(.router-link-active, .rd-link-active) :deep(div) {
    background-color: var(--nav-active);
  }
}

.nav-badge {
  line-height: initial;
  letter-spacing: initial;
  font-size: var(--fs-body-sm);
}

.nav-button-container {
  display: flex;
  flex-direction: column;
  justify-content: center;

  .nav-button {
    flex: 1;
    margin: 5px 10px 0px 10px;
    justify-content: center;
  }
}

.docker-nav-heading,
.docker-nav-glyph,
.docker-nav-indicator {
  display: none;
}

.theme-noir .docker-nav {
  padding: 18px 12px;
  background: color-mix(in srgb, var(--bg-surface-alt) 60%, transparent);
  border-right: 1px solid var(--nx-hair);
}

.theme-noir .docker-nav-heading {
  display: block;
  padding: 20px 8px 18px;
}

.theme-noir .docker-nav-title {
  color: var(--nx-read-1);
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.theme-noir .docker-nav-subtitle {
  margin-top: 3px;
  color: var(--nx-read-4);
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 10.5px;
  letter-spacing: 0.04em;
}

.theme-noir .docker-nav-routes {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.theme-noir .docker-nav-indicator {
  display: block;
  position: absolute;
  inset: 0 0 auto;
  border-radius: 20px;
  pointer-events: none;
  background: linear-gradient(180deg, color-mix(in srgb, var(--nx-accent) 28%, transparent), color-mix(in srgb, var(--nx-accent) 12%, transparent));
  box-shadow: inset 0 0 0 0.5px color-mix(in srgb, var(--nx-accent-2) 50%, transparent), 0 0 20px color-mix(in srgb, var(--nx-accent) 20%, transparent);
  transition: transform .58s linear(0,.0258,.09,.1763,.2732,.3724,.4683,.5573,.6376,.7082,.7689,.8202,.8628,.8976,.9256,.9476,.9648,.9778,.9875,.9945,.9994,1.0026,1.0047,1.0058,1.0062,1.0062,1.0059,1.0055,1.0049,1.0043,1.0036,1.0031,1.0025,1.002,1.0016,1.0013,1), opacity .16s;
}

.theme-noir .docker-nav-indicator::before {
  content: '';
  position: absolute;
  left: -12px;
  top: 9px;
  width: 3px;
  height: 22px;
  border-radius: 0 3px 3px 0;
  background: var(--nx-accent-2);
  box-shadow: 0 0 10px var(--nx-accent-2);
}

.theme-noir .docker-nav-routes li a {
  position: relative;
  z-index: 1;
  min-height: 40px;
  padding: 0 14px;
  border-radius: 20px;
  gap: 11px;
  color: var(--nx-read-3);
  font-size: 13.5px;
  font-weight: 500;
  line-height: 40px;
  transition: color .16s, background .16s, transform .45s ease;
}

.theme-noir .docker-nav-routes li a:hover {
  color: var(--nx-read-2);
  background: color-mix(in srgb, var(--nx-accent) 8%, transparent);
}

.theme-noir .docker-nav-routes li a:is(.router-link-active, .rd-link-active) {
  color: var(--nx-read-1);
  background: transparent;
}

.theme-noir .docker-nav-glyph {
  display: inline-block;
  width: 18px;
  color: #8cacc9;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  text-align: center;
}

.theme-noir-light .docker-nav-glyph {
  color: var(--nx-accent);
}

.theme-noir .nav-button-container {
  padding-top: 12px;
  border-top: 1px solid var(--nx-hair);
}

@media (prefers-reduced-motion: reduce) {
  .theme-noir .docker-nav-indicator,
  .theme-noir .docker-nav-routes li a {
    transition: none;
  }
}

</style>
