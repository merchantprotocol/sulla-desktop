<!--
  Full-screen backdrop shown while files are being dragged over the window.
-->
<template>
  <Transition name="drop-fade">
    <div v-if="active" class="drop-overlay" aria-hidden="true">
      <div class="drop-card">
        <div class="drop-icon">◇</div>
        <div class="drop-title">drop to attach</div>
        <div class="drop-sub">Sulla will read the files along with your message</div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
defineProps<{ active: boolean }>();
</script>

<style scoped>
.drop-overlay {
  position: absolute; inset: 0; z-index: 100;
  display: flex; align-items: center; justify-content: center;
  background: rgba(7, 13, 26, 0.78);
  backdrop-filter: blur(10px);
  pointer-events: none;
}
.drop-card {
  text-align: center; padding: 48px 72px;
  border: 2px dashed var(--steel-400); border-radius: 16px;
  background: rgba(20, 30, 42, 0.55);
  box-shadow: 0 0 60px rgba(106, 176, 204, 0.3);
}
.drop-icon {
  font-size: 44px; color: var(--steel-400); margin-bottom: 14px;
  filter: drop-shadow(0 0 14px rgba(106, 176, 204, 0.45));
}
.drop-title {
  font-family: var(--serif); font-style: italic; font-size: 22px;
  color: white; margin-bottom: 8px;
}
.drop-sub {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.28em;
  text-transform: uppercase; color: var(--steel-300);
}
.drop-fade-enter-active, .drop-fade-leave-active { transition: opacity 0.18s ease; }
.drop-fade-enter-from,  .drop-fade-leave-to    { opacity: 0; }
</style>
