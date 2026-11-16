<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script setup lang="ts">
/** The unsaved-changes bar, fixed to the window: what will change, Discard and Save. */
defineProps<{ pending: string[] }>();
const emit = defineEmits<{ (e: 'discard'): void; (e: 'save'): void }>();
</script>

<template>
  <Teleport to="body">
    <div
      class="ld-bar"
      role="region"
      aria-label="Unsaved changes"
    >
      <div class="ld-bar-c">
        <b>{{ pending.length }} unsaved {{ pending.length === 1 ? 'change' : 'changes' }}</b>
        <span>Nothing applies until you save.</span>
      </div>
      <ol>
        <li
          v-for="(x, n) in pending"
          :key="n"
          :title="x"
        >
          {{ x }}
        </li>
      </ol>
      <div class="ld-bar-a">
        <button
          type="button"
          class="ld-btn"
          @click="emit('discard')"
        >
          Discard
        </button>
        <button
          type="button"
          class="ld-btn ld-btn-pri"
          @click="emit('save')"
        >
          Save changes
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped src="./RoleLedger.css"></style>
