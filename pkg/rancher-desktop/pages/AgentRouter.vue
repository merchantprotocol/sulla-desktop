<template>
  <div class="agent-router-root">
    <!--
      Non-browser routes use keep-alive normally.
      Hidden when a browser tab is the active route.
    -->
    <router-view
      v-slot="{ Component }"
      v-show="!isBrowserRoute"
    >
      <keep-alive>
        <component
          :is="Component"
          :key="route.path"
        />
      </keep-alive>
    </router-view>

    <!--
      Browser tabs are rendered OUTSIDE of keep-alive so their iframes
      are never removed from the DOM.  We avoid v-show (display:none)
      because browsers tear down the iframe render tree when display
      is none, causing a visible "blink" on re-show.  Instead we use
      visibility:hidden + pointer-events:none so the iframe stays
      fully rendered and composited in the background.
    -->
    <BrowserTab
      v-for="tab in browserTabs"
      :key="tab.id"
      class="browser-tab-layer"
      :class="{ 'browser-tab-hidden': route.path !== `/Browser/${tab.id}` }"
      :tab-id="tab.id"
      :is-visible="route.path === `/Browser/${tab.id}`"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

import BrowserTab from './BrowserTab.vue';
import { useBrowserTabs } from '@pkg/composables/useBrowserTabs';

const route = useRoute();
const { tabs: browserTabs } = useBrowserTabs();

const isBrowserRoute = computed(() => route.path.startsWith('/Browser/'));
</script>

<style scoped>
.agent-router-root {
  position: relative;
  width: 100%;
  height: 100vh;
  overflow: hidden;
}

/*
 * Each BrowserTab fills the router root absolutely.  The active tab
 * sits on top with normal visibility; hidden tabs remain rendered
 * but are invisible and non-interactive — avoiding the display:none
 * blink that occurs when browsers tear down iframe render trees.
 */
.browser-tab-layer {
  position: absolute;
  inset: 0;
  z-index: 1;
}

.browser-tab-hidden {
  visibility: hidden;
  pointer-events: none;
  z-index: 0;
}
</style>
