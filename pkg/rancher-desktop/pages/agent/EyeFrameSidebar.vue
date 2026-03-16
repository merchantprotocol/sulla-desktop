<template>
  <div
    class="border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900/60"
    :class="expanded ? 'border-l mt-0 flex h-full min-h-0 flex-col' : 'border rounded-2xl mt-6'"
  >
    <div class="mb-2 flex items-center justify-between gap-2">
      <div class="inline-flex items-center gap-2 rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold tracking-wide text-slate-700 dark:bg-slate-800 dark:text-slate-300">
        <span
          class="h-2 w-2 rounded-full"
          :class="active ? 'bg-emerald-500' : 'bg-slate-400 dark:bg-slate-500'"
        />
        {{ active ? 'Iframe Active' : 'Iframe Inactive' }}
      </div>

      <button
        type="button"
        class="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
        @click="$emit('toggle-expand')"
      >
        {{ expanded ? 'Collapse' : 'Expand 70%' }}
      </button>
    </div>

    <div
      class="w-full overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700"
      :class="expanded ? 'min-h-0 flex-1' : 'h-80'"
    >
      <webview
        :src="src"
        :title="title"
        class="block h-full w-full"
        :style="expanded
          ? undefined
          : {
            transform: 'scale(0.35)',
            transformOrigin: 'top left',
            width: '285.7143%',
            height: '285.7143%',
          }"
        partition="persist:sulla"
        allowpopups
        webpreferences="allowRunningInsecureContent=yes, webSecurity=no, nodeIntegrationInSubFrames=yes"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  src:      string;
  title:    string;
  active:   boolean;
  expanded: boolean;
}>();

defineEmits<(e: 'toggle-expand') => void>();
</script>
