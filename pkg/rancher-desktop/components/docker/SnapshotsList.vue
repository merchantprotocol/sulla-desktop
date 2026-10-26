<template>
  <section class="docker-section" :aria-label="label">
    <slot />
  </section>
</template>

<script setup lang="ts">
defineProps<{ label?: string }>();
</script>
