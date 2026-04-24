<template>
  <div class="time-marker"><span>{{ label }}</span></div>
</template>

<script setup lang="ts">
defineProps<{ label: string }>();
</script>

<style scoped>
.time-marker {
  display: flex; align-items: center; gap: 18px;
  margin: 10px 0;
}
.time-marker::before,
.time-marker::after {
  content: ""; flex: 1; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(168, 192, 220, 0.22), transparent);
}
.time-marker span {
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.35em;
  text-transform: uppercase; color: var(--read-4);
}
</style>
