<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!-- Sulla Desktop · Copyright (c) 2025-2026 Merchant Protocol LLC. -->
<script setup lang="ts">
import { useDebugErrors } from '@pkg/composables/useDebugErrors';

const { errors, dismiss, clear } = useDebugErrors();
async function copy(error: { source: string; message: string; stack: string }) {
  await navigator.clipboard.writeText(`${ error.source }: ${ error.message }\n${ error.stack }`);
}
</script>

<template>
  <aside v-if="errors.length" class="debug-error-overlay" aria-label="Debug errors">
    <header><b>Debug errors ({{ errors.length }})</b><button type="button" @click="clear">Clear all</button></header>
    <article v-for="(error, index) in errors" :key="`${error.timestamp}-${index}`">
      <div class="row"><strong>{{ error.source }}</strong><button type="button" @click="dismiss(index)">Dismiss</button></div>
      <p>{{ error.message }}</p>
      <pre>{{ error.stack }}</pre>
      <button type="button" @click="copy(error)">Copy</button>
    </article>
  </aside>
</template>

<style scoped>
.debug-error-overlay{position:fixed;right:16px;bottom:16px;z-index:10000;width:min(620px,calc(100vw - 32px));max-height:55vh;overflow:auto;padding:12px;background:var(--surface-1);color:var(--text);border:1px solid var(--danger);border-radius:8px;box-shadow:0 8px 32px #0003}.debug-error-overlay header,.row{display:flex;justify-content:space-between;gap:12px}.debug-error-overlay article{border-top:1px solid var(--border);padding:10px 0}.debug-error-overlay p{margin:6px 0}.debug-error-overlay pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:140px;overflow:auto;font-size:11px;color:var(--text-muted)}.debug-error-overlay button{cursor:pointer}
</style>
