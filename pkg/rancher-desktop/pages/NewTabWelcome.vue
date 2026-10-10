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

:global(.theme-noir-dark) .new-tab-root {
  display: grid;
  place-items: start center;
  padding: clamp(52px, 10vh, 112px) 24px 32px;
  background: radial-gradient(70% 55% at 50% 18%, rgba(80, 150, 179, .12), transparent 70%), #01030a;
}
:global(.theme-noir-dark) .noir-launcher {
  display: block;
  width: min(520px, 100%);
  animation: noir-launch-enter .48s cubic-bezier(.22, 1, .36, 1) both;
}
:global(.theme-noir-dark) .noir-launch-field {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  height: 54px;
  padding: 0 20px;
  border: 0;
  border-radius: 27px;
  background: rgba(168, 192, 220, .05);
  box-shadow: inset 0 0 0 1px rgba(106, 176, 204, .38), 0 0 34px rgba(80, 150, 179, .16), 0 18px 50px rgba(0, 0, 0, .25);
  color: #7a8291;
  font: 15px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  cursor: text;
  text-align: left;
}
:global(.theme-noir-dark) .noir-launch-field svg { width: 18px; height: 18px; fill: none; stroke: #6ab0cc; stroke-width: 1.7; }
:global(.theme-noir-dark) .noir-launch-field span { flex: 1; }
:global(.theme-noir-dark) .noir-launch-field i { width: 1.5px; height: 20px; background: #6ab0cc; box-shadow: 0 0 8px #6ab0cc; animation: noir-launch-caret 1s steps(1) infinite; }
:global(.theme-noir-dark) .noir-launch-list {
  margin-top: 12px;
  padding: 6px;
  border-radius: 18px;
  background: rgba(168, 192, 220, .03);
  box-shadow: inset 0 0 0 1px rgba(168, 192, 220, .08);
}
:global(.theme-noir-dark) .noir-launch-list button {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  min-height: 42px;
  padding: 0 12px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: #a9b3c1;
  font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  cursor: pointer;
  transition: transform .45s cubic-bezier(.22, 1, .36, 1), color .16s, background .16s;
}
:global(.theme-noir-dark) .noir-launch-list button:hover { color: #f3f5f8; background: rgba(80, 150, 179, .12); transform: translateX(2px); }
:global(.theme-noir-dark) .noir-launch-glyph { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 8px; color: #6ab0cc; background: rgba(80, 150, 179, .1); }
:global(.theme-noir-dark) .noir-launch-list kbd { margin-left: auto; padding: 0; border: 0; background: transparent; color: #484f5a; font: 10.5px ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace; }
@keyframes noir-launch-enter { from { opacity: 0; transform: translateY(8px); filter: blur(8px); } to { opacity: 1; transform: none; filter: none; } }
@keyframes noir-launch-caret { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  :global(.theme-noir-dark) .noir-launcher,
  :global(.theme-noir-dark) .noir-launch-field i { animation: none; }
  :global(.theme-noir-dark) .noir-launch-list button { transition: none; }
}
</style>
