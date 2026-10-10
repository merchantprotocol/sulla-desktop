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

:global(.theme-noir-dark) .notes { margin-top: 14px; padding: 14px; border: 1px solid rgba(168,192,220,.07); border-radius: 14px; background: rgba(3,6,12,.42); }
:global(.theme-noir-dark) h3 { color: #6ab0cc; }
:global(.theme-noir-dark) ul { gap: 8px; padding: 0; list-style: none; }
:global(.theme-noir-dark) li { position: relative; padding: 9px 10px 9px 22px; border: 1px solid rgba(168,192,220,.06); border-radius: 11px; background: rgba(168,192,220,.025); color: #a9b3c1; }
:global(.theme-noir-dark) li::before { content: ''; position: absolute; left: 10px; top: 15px; width: 5px; height: 5px; border-radius: 50%; background: #5096b3; box-shadow: 0 0 7px rgba(80,150,179,.7); }
</style>
