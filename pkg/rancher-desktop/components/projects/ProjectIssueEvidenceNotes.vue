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

:global(.theme-noir) .notes { margin-top: 14px; padding: 14px; border: 1px solid color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 7%, transparent); border-radius: 14px; background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .42); }
:global(.theme-noir) h3 { color: var(--nx-accent-2); }
:global(.theme-noir) ul { gap: 8px; padding: 0; list-style: none; }
:global(.theme-noir) li { position: relative; padding: 9px 10px 9px 22px; border: 1px solid color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 6%, transparent); border-radius: 11px; background: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 2.5%, transparent); color: var(--nx-read-3); }
:global(.theme-noir) li::before { content: ''; position: absolute; left: 10px; top: 15px; width: 5px; height: 5px; border-radius: 50%; background: var(--nx-accent); box-shadow: 0 0 7px color-mix(in srgb, var(--nx-accent) 70%, transparent); }
</style>
