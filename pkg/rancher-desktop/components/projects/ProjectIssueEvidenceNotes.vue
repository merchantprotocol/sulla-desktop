<template>
  <div class="notes">
    <h3>{{ title }}</h3>
    <ul v-if="items.length">
      <li
        v-for="item in items"
        :key="item"
      >
        {{ item }}
      </li>
    </ul>
    <p v-else>
      {{ emptyLabel }}
    </p>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ title: string; items: string[]; emptyLabel?: string }>(), {
  emptyLabel: 'No evidence recorded.',
});
</script>

<style scoped>
.notes { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--pborder); }
h3 { margin: 0 0 8px; color: var(--ptext3); font: 600 11px var(--pmono); letter-spacing: .08em; text-transform: uppercase; }
ul { display: grid; gap: 7px; margin: 0; padding-left: 18px; color: var(--ptext2); font-size: 11px; line-height: 1.5; }
p { margin: 0; color: var(--ptext3); font-size: 11px; }
</style>
