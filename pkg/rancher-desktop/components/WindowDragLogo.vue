<template>
  <div class="window-drag-logo">
    <template v-if="forceDark">
      <img
        :src="logoDarkUrl"
        alt=""
        class="window-drag-logo-img"
        :style="{ height: size + 'px' }"
        draggable="false"
        @dragstart.prevent
      >
    </template>
    <template v-else>
      <img
        :src="logoLightUrl"
        alt=""
        class="window-drag-logo-img dark:hidden"
        :style="{ height: size + 'px' }"
        draggable="false"
        @dragstart.prevent
      >
      <img
        :src="logoDarkUrl"
        alt=""
        class="window-drag-logo-img hidden dark:block"
        :style="{ height: size + 'px' }"
        draggable="false"
        @dragstart.prevent
      >
    </template>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number; forceDark?: boolean }>(), { size: 20, forceDark: false });

const logoLightUrl = new URL('../../../resources/icons/logo-sulla-desktop-nobg.png', import.meta.url).toString();
const logoDarkUrl = new URL('../../../resources/icons/logo-sulla-desktop-dark-nobg.png', import.meta.url).toString();
</script>

<style scoped>
.window-drag-logo {
  -webkit-app-region: drag;
  app-region: drag;
  display: flex;
  align-items: center;
  padding: 4px;
  flex-shrink: 0;
}

.window-drag-logo-img {
  width: auto;
  pointer-events: none;
  user-select: none;
  -webkit-user-drag: none;
}
</style>
