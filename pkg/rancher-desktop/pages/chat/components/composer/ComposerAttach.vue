<!-- Paperclip button — spawns the file-picker or a demo attachment. -->
<template>
  <button
    :class="['attach-btn', { open }]"
    type="button"
    title="Attach a file"
    @click="$emit('pick')"
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
    </svg>
  </button>
</template>

<script setup lang="ts">
defineProps<{ open?: boolean }>();
defineEmits<{ (e: 'pick'): void }>();
</script>

<style scoped>
.attach-btn {
  width: 36px; height: 36px; border-radius: 50%;
  background: transparent;
  border: 1px solid rgba(168, 192, 220, 0.22);
  color: var(--read-3); font-size: 15px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; flex-shrink: 0; align-self: center;
  transition: all 0.2s ease; padding: 0;
}
.attach-btn:hover {
  background: rgba(80, 150, 179, 0.18);
  border-color: var(--steel-400); color: var(--steel-400);
  box-shadow: 0 0 14px rgba(106, 176, 204, 0.3);
}
:global(.theme-noir) .attach-btn {
  position: relative; width: 34px; height: 34px; border: 0; color: var(--nx-read-3);
  transition: background 0.16s, color 0.16s, transform 0.5s linear(0, .0258, .09, .1763, .2732, .3724, .4683, .5573, .6376, .7082, .7689, .8202, .8628, .8976, .9256, .9476, .9648, .9778, .9875, .9945, .9994, 1.0026, 1.0047, 1.0058, 1.0062, 1.0062, 1.0059, 1.0055, 1.0049, 1.0043, 1.0036, 1.0031, 1.0025, 1.002, 1.0016, 1.0013, 1);
}
:global(.theme-noir) .attach-btn svg { display: none; }
:global(.theme-noir) .attach-btn::before,
:global(.theme-noir) .attach-btn::after {
  content: ""; position: absolute; left: 50%; top: 50%; width: 13px; height: 1.8px;
  margin: -0.9px 0 0 -6.5px; border-radius: 1px; background: currentColor;
  transition: transform 0.5s linear(0, .0258, .09, .1763, .2732, .3724, .4683, .5573, .6376, .7082, .7689, .8202, .8628, .8976, .9256, .9476, .9648, .9778, .9875, .9945, .9994, 1.0026, 1.0047, 1.0058, 1.0062, 1.0062, 1.0059, 1.0055, 1.0049, 1.0043, 1.0036, 1.0031, 1.0025, 1.002, 1.0016, 1.0013, 1);
}
:global(.theme-noir) .attach-btn::after { transform: rotate(90deg); }
:global(.theme-noir) .attach-btn.open { color: var(--nx-read-1); background: color-mix(in srgb, var(--nx-accent) 14%, transparent); }
:global(.theme-noir) .attach-btn.open::before { transform: rotate(45deg); }
:global(.theme-noir) .attach-btn.open::after { transform: rotate(135deg); }
:global(.theme-noir) .attach-btn:hover { border: 0; color: var(--nx-read-1); background: color-mix(in srgb, var(--nx-accent) 12%, transparent); box-shadow: none; }
</style>
