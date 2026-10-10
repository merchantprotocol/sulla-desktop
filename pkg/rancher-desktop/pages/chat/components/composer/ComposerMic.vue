<!-- Mic / stop toggle (steel-blue). -->
<template>
  <button
    :class="['mic-btn', { live }]"
    type="button"
    :title="live ? 'Stop recording' : 'Start voice input (⌘/)'"
    @click="$emit('toggle')"
  >
    <span class="classic-mic">{{ live ? '■' : '◉' }}</span>
    <svg class="noir-mic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v4M9 21h6" />
    </svg>
  </button>
</template>

<script setup lang="ts">
defineProps<{ live?: boolean }>();
defineEmits<{ (e: 'toggle'): void }>();
</script>

<style scoped>
.mic-btn {
  width: 36px; height: 36px; border-radius: 50%;
  background: rgba(80, 150, 179, 0.08);
  border: 1px solid rgba(80, 150, 179, 0.28);
  color: var(--steel-300); font-size: 15px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; flex-shrink: 0; align-self: center;
  transition: all 0.2s ease; padding: 0;
}
.mic-btn:hover {
  background: rgba(80, 150, 179, 0.18);
  border-color: var(--steel-400); color: var(--steel-400);
  box-shadow: 0 0 14px rgba(106, 176, 204, 0.3);
}
.mic-btn.live {
  background: var(--steel-500); border-color: var(--steel-400);
  color: white; animation: chat-pulse-glow 1.6s ease-in-out infinite;
}
.noir-mic { display: none; width: 17px; height: 17px; }
:global(.theme-noir) .mic-btn {
  width: 34px; height: 34px; border: 0; color: var(--nx-read-3); background: transparent;
  transition: background 0.16s, color 0.16s, box-shadow 0.16s;
}
:global(.theme-noir) .classic-mic { display: none; }
:global(.theme-noir) .noir-mic { display: block; }
:global(.theme-noir) .mic-btn:hover { border: 0; color: var(--nx-read-1); background: color-mix(in srgb, var(--nx-accent) 12%, transparent); box-shadow: none; }
:global(.theme-noir) .mic-btn.live {
  color: var(--nx-read-1); background: color-mix(in srgb, var(--nx-accent) 30%, transparent); border: 0;
  animation: noir-mic-pulse 1.6s cubic-bezier(.22, 1, .36, 1) infinite;
}
@keyframes noir-mic-pulse {
  from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--nx-accent-2) 45%, transparent); }
  to { box-shadow: 0 0 0 12px color-mix(in srgb, var(--nx-accent-2) 0%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  :global(.theme-noir) .mic-btn.live { animation: none; }
}
</style>
