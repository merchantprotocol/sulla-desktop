<template>
  <div class="studio-page">
    <StudioTopbar :crumbs="['Token Usage']" />
    <div class="studio-content">
      <div class="tb"><h1>Token Usage</h1></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import StudioTopbar from './StudioTopbar.vue';
</script>

<style scoped lang="scss">
@import '@pkg/assets/styles/studio-ui.scss';
</style>
