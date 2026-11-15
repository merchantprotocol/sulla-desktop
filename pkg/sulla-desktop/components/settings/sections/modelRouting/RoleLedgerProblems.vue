<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script setup lang="ts">
/** What is wrong with a ledger line, each with one-click fixes. */
defineProps<{ problems: { text: string; fixes: { label: string; run: () => void }[] }[] }>();
</script>

<template>
  <div class="ld-prob">
    <div
      v-for="(p, pi) in problems"
      :key="pi"
      class="ld-prob-row"
      role="alert"
    >
      <svg
        class="ld-i"
        viewBox="0 0 16 16"
        aria-hidden="true"
      ><path d="M8 2.2 14.3 13H1.7L8 2.2Z" /><path d="M8 6.5v3" /><path d="M8 11.3v.2" /></svg>
      <span>{{ p.text }}</span>
      <button
        v-for="f in p.fixes"
        :key="f.label"
        type="button"
        class="ld-fix"
        @click="f.run()"
      >
        {{ f.label }}
      </button>
    </div>
  </div>
</template>

<style scoped src="./RoleLedger.css"></style>
