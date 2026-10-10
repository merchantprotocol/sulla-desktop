<template>
  <div class="new-tab-root">
    <div
      class="noir-launcher"
      aria-label="New tab shortcuts"
    >
      <button
        class="noir-launch-field"
        type="button"
        @click="$emit('start-chat', '')"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
        ><circle
          cx="11"
          cy="11"
          r="7"
        /><path d="m20 20-4-4" /></svg>
        <span>Search, open a URL, or ask Sulla…</span>
        <i />
      </button>
      <div class="noir-launch-list">
        <button
          type="button"
          @click="$emit('start-chat', '')"
        >
          <span class="noir-launch-glyph">+</span>New chat<kbd>⌘N</kbd>
        </button>
        <button
          type="button"
          @click="$emit('set-mode', 'projects')"
        >
          <span class="noir-launch-glyph">◆</span>Projects · Sulla Desktop<kbd>⌘5</kbd>
        </button>
        <button
          type="button"
          @click="$emit('set-mode', 'secretary')"
        >
          <span class="noir-launch-glyph">◉</span>Secretary mode<kbd>⌘⇧S</kbd>
        </button>
        <button
          type="button"
          @click="$emit('set-mode', 'decide')"
        >
          <span class="noir-launch-glyph">✓</span>Decide<kbd>review</kbd>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineEmits<{
  'start-chat': [query: string];
  'set-mode':   [mode: string];
}>();
</script>

<style scoped>
.new-tab-root {
  width: 100%;
  height: 100%;
  background: var(--bg-page);
}

.noir-launcher { display: none; }

.theme-noir .new-tab-root {
  display: grid;
  place-items: start center;
  padding: clamp(52px, 10vh, 112px) 24px 32px;
  background: radial-gradient(70% 55% at 50% 18%, color-mix(in srgb, var(--nx-accent) 833.3333%, transparent), transparent 70%), var(--nx-paper);
}
.theme-noir .noir-launcher {
  display: block;
  width: min(520px, 100%);
  animation: noir-launch-enter .48s cubic-bezier(.22, 1, .36, 1) both;
}
.theme-noir .noir-launch-field {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  height: 54px;
  padding: 0 20px;
  border: 0;
  border-radius: 27px;
  background: color-mix(in srgb, var(--nx-hair-strong) 320%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-accent-2) 263.1579%, transparent), 0 0 34px color-mix(in srgb, var(--nx-accent) 625%, transparent), 0 18px 50px color-mix(in srgb, var(--shadow) 360%, transparent);
  color: var(--nx-read-4);
  font: 15px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  cursor: text;
  text-align: left;
}
.theme-noir .noir-launch-field svg { width: 18px; height: 18px; fill: none; stroke: var(--nx-accent-2); stroke-width: 1.7; }
.theme-noir .noir-launch-field span { flex: 1; }
.theme-noir .noir-launch-field i { width: 1.5px; height: 20px; background: var(--nx-accent-2); box-shadow: 0 0 8px var(--nx-accent-2); animation: noir-launch-caret 1s steps(1) infinite; }
.theme-noir .noir-launch-list {
  margin-top: 12px;
  padding: 6px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--nx-hair-strong) 533.3333%, transparent);
  box-shadow: inset 0 0 0 1px var(--nx-hair);
}
.theme-noir .noir-launch-list button {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  min-height: 42px;
  padding: 0 12px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--nx-read-3);
  font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  cursor: pointer;
  transition: transform .45s cubic-bezier(.22, 1, .36, 1), color .16s, background .16s;
}
.theme-noir .noir-launch-list button:hover { color: var(--nx-read-1); background: color-mix(in srgb, var(--nx-accent) 833.3333%, transparent); transform: translateX(2px); }
.theme-noir .noir-launch-glyph { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 8px; color: var(--nx-accent-2); background: color-mix(in srgb, var(--nx-accent) 1000%, transparent); }
.theme-noir .noir-launch-list kbd { margin-left: auto; padding: 0; border: 0; background: transparent; color: var(--nx-read-5); font: 10.5px ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace; }
@keyframes noir-launch-enter { from { opacity: 0; transform: translateY(8px); filter: blur(8px); } to { opacity: 1; transform: none; filter: none; } }
@keyframes noir-launch-caret { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .theme-noir .noir-launcher,
  .theme-noir .noir-launch-field i { animation: none; }
  .theme-noir .noir-launch-list button { transition: none; }
}
</style>
