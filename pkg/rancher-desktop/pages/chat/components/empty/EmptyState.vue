<!--
  Empty-state landing — pixel-matched to
  _design-ideas/chat-whisper-full.html (`.empty` block).
-->
<template>
  <div class="empty">
    <div class="e-kicker"><span>Sulla</span></div>
    <h1>What shall we work on?</h1>
    <p class="lede">
      Ask a question, paste a URL, drop a file, or hit the mic. I'll carry the burden.
    </p>
    <div class="suggests">
      <button
        v-for="s in suggestions"
        :key="s"
        class="sug"
        type="button"
        @click="$emit('pick', s)"
      >{{ s }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  suggestions: readonly string[];
}>();

defineEmits<{
  (e: 'pick', text: string): void;
}>();
</script>

<style scoped>
.empty {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  z-index: 6;
  text-align: center;
  padding: 20vh 15%;
}

.e-kicker {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.4em;
  text-transform: uppercase; color: var(--steel-400);
  margin-bottom: 20px;
  display: inline-flex; align-items: center; gap: 14px;
}
.e-kicker::before,
.e-kicker::after {
  content: ""; width: 28px; height: 1px;
  background: var(--steel-500); opacity: 0.5;
}

h1 {
  font-family: var(--serif); font-style: italic; font-size: 44px;
  font-weight: 600; color: white; margin: 0 0 14px;
  letter-spacing: -0.01em; line-height: 1.1;
}

.lede {
  font-family: var(--serif); font-size: 17px; line-height: 1.65;
  color: var(--read-3); max-width: 580px;
  margin-bottom: 36px;
}

.suggests {
  display: flex; gap: 10px; flex-wrap: wrap; justify-content: center;
}
.sug {
  padding: 9px 16px; border-radius: 100px;
  font-family: var(--serif); font-style: italic; font-size: 13px;
  background: rgba(20, 30, 42, 0.55);
  border: 1px solid rgba(168, 192, 220, 0.2);
  color: var(--read-2); cursor: pointer;
  transition: all 0.15s ease;
}
.sug:hover {
  background: rgba(80, 150, 179, 0.12);
  border-color: var(--steel-400); color: white;
}
</style>
