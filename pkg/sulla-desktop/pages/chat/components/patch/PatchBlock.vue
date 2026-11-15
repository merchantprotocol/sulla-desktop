<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Inline patch block: head + body + actions (Apply / Open / Reject).
  Opening a patch spawns a code artifact; applying flips the state and
  dims the body.
-->
<template>
  <WorkBlock
    icon="±"
    tone="patch"
    :by="msg.by"
    :default-open="false"
  >
    <template #title>
      <span
        class="pb-state"
        :class="`pb-${msg.state}`"
      >{{ STATE_LABEL[msg.state] }}</span> · <b>{{ fileName }}</b><template v-if="folder">
        · {{ folder }}
      </template>
    </template>
    <template #meta>
      <span class="pb-plus">+{{ msg.stat.added }}</span> <span class="pb-minus">−{{ msg.stat.removed }}</span>
    </template>

    <p class="pb-path">
      <code>{{ msg.path }}</code><span>{{ isNewFile ? 'new file · ' : '' }}{{ flatLines.length }} line{{ flatLines.length === 1 ? '' : 's' }}</span>
    </p>
    <div class="pb-diff">
      <div
        v-for="(line, idx) in shownLines"
        :key="idx"
        :class="['pb-l', `pb-${line.op}`]"
      >
        <span class="pb-n">{{ line.n }}</span>
        <span class="pb-op">{{ line.op === 'add' ? '+' : line.op === 'remove' ? '−' : '' }}</span>
        <span v-html="line.text" />
      </div>
      <button
        v-if="hiddenCount"
        type="button"
        class="pb-more"
        @click="showAll = true"
      >
        Show {{ hiddenCount }} more line{{ hiddenCount === 1 ? '' : 's' }}
      </button>
    </div>
    <div
      v-if="msg.state !== 'proposed'"
      class="pb-acts"
    >
      <button
        type="button"
        class="pb-btn"
        @click="open"
      >
        Open file
      </button>
      <button
        type="button"
        class="pb-btn pb-quiet"
        @click="copyPatch"
      >
        {{ copied ? 'Copied' : 'Copy patch' }}
      </button>
      <span class="pb-sp" />
      <button
        v-if="msg.state === 'applied' && canRevert"
        type="button"
        class="pb-btn pb-quiet pb-danger"
        :disabled="reverting"
        @click="revert"
      >
        {{ reverting ? 'Reverting…' : 'Revert' }}
      </button>
    </div>

    <!-- A proposed patch waits on the user: its decision stays visible without expanding. -->
    <template #after>
      <div
        v-if="msg.state === 'proposed'"
        class="pb-acts pb-decide"
      >
        <button
          type="button"
          class="pb-btn pb-pri"
          @click="apply"
        >
          Apply
        </button>
        <button
          type="button"
          class="pb-btn"
          @click="open"
        >
          Open file
        </button>
        <span class="pb-sp" />
        <button
          type="button"
          class="pb-btn pb-quiet pb-danger"
          @click="reject"
        >
          Reject
        </button>
      </div>
    </template>
  </WorkBlock>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import { useChatController } from '../../controller/useChatController';
import WorkBlock from '../transcript/WorkBlock.vue';

import type { CodePayload } from '../../models/Artifact';
import type { PatchMessage } from '../../models/Message';

const props = defineProps<{ msg: PatchMessage }>();
const controller = useChatController();

const reverting = ref(false);
const copied = ref(false);

const flatLines = computed(() => props.msg.hunks.flatMap(h => h.lines));
const PREVIEW_LINES = 6;
const STATE_LABEL = { proposed: 'Proposed', applied: 'Applied', rejected: 'Rejected' } as const;
const showAll = ref(false);
const shownLines = computed(() => (showAll.value ? flatLines.value : flatLines.value.slice(0, PREVIEW_LINES)));
const hiddenCount = computed(() => Math.max(0, flatLines.value.length - shownLines.value.length));
const fileName = computed(() => props.msg.path.split('/').pop() || props.msg.path);
/** The last two folders, enough to tell files apart without the full path. */
const folder = computed(() => props.msg.path.split('/').slice(0, -1).filter(Boolean).slice(-2).join(' / '));
const isNewFile = computed(() => props.msg.stat.removed === 0 && flatLines.value.length > 0 && flatLines.value.every(line => line.op === 'add'));
const canRevert = computed(() => !!props.msg.revertMeta);

function apply(): void {
  controller.applyPatch(props.msg.id);
}
function reject(): void {
  controller.rejectPatch(props.msg.id);
}
async function revert(): Promise<void> {
  if (!props.msg.revertMeta || reverting.value) return;
  reverting.value = true;
  try {
    await controller.revertPatch(props.msg.id, props.msg.revertMeta);
  } finally {
    reverting.value = false;
  }
}
function open(): void {
  // Spawn a code artifact populated from the patch
  const payload: CodePayload = {
    path:     props.msg.path,
    language: 'typescript',
    lines:    flatLines.value.map(l => ({ n: l.n, text: l.text, op: l.op })),
  };
  controller.openArtifact('code', { name: props.msg.path.split('/').pop(), payload, status: 'editing' });
}
function copyPatch(): void {
  const text = flatLines.value.map((line) => {
    const node = document.createElement('span');
    node.innerHTML = line.text;
    const prefix = line.op === 'add' ? '+' : line.op === 'remove' ? '-' : ' ';

    return `${ prefix }${ node.textContent ?? '' }`;
  }).join('\n');

  navigator.clipboard?.writeText(text).then(() => {
    copied.value = true;
    window.setTimeout(() => { copied.value = false }, 1_500);
  }).catch(() => undefined);
}
</script>

<style scoped>
.pb-state { font-size: 11px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; }
.pb-applied { color: var(--status-success); }
.pb-proposed { color: var(--status-warning); }
.pb-rejected { color: var(--wb-ink-3); }
.pb-plus { color: var(--status-success); }
.pb-minus { color: var(--status-error); }
.pb-path { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; margin: 8px 0; font-size: 12.5px; color: var(--wb-ink-3); }
.pb-path code { color: var(--text-primary); font: 12px var(--font-mono, ui-monospace, monospace); overflow-wrap: anywhere; }
.pb-diff { overflow: hidden; border: 1px solid var(--border-default); border-radius: 8px; font: 12.5px/1.6 var(--font-mono, ui-monospace, monospace); }
.pb-l { display: grid; grid-template-columns: 36px 14px minmax(0, 1fr); padding: 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--wb-ink-2); }
.pb-n { color: var(--wb-ink-3); }
.pb-add { background: color-mix(in srgb, var(--status-success) 9%, transparent); color: color-mix(in srgb, var(--status-success) 70%, var(--text-primary)); }
.pb-remove { background: color-mix(in srgb, var(--status-error) 9%, transparent); color: color-mix(in srgb, var(--status-error) 70%, var(--text-primary)); }
.pb-more { display: block; width: 100%; padding: 6px; border: 0; border-top: 1px solid var(--border-default); background: var(--wb-raised); color: var(--accent); font-family: var(--font-body); font-size: 12.5px; cursor: pointer; }
.pb-acts { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
.pb-decide { margin: 0; padding: 0 12px 10px 44px; }
.pb-sp { flex: 1; }
.pb-btn { height: 30px; padding: 0 12px; border: 1px solid var(--border-strong); border-radius: 8px; background: transparent; color: var(--text-primary); font-family: var(--font-body); font-size: 12.5px; cursor: pointer; }
.pb-btn:hover:not(:disabled) { border-color: var(--accent); }
.pb-btn:focus-visible, .pb-more:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.pb-btn:disabled { opacity: .5; cursor: wait; }
.pb-quiet { border-color: transparent; color: var(--wb-ink-2); }
.pb-danger { color: var(--status-error); }
.pb-pri { background: var(--accent); border-color: var(--accent); color: var(--bg-page); font-weight: 650; }
@media (max-width: 640px) { .pb-decide { padding-left: 12px; } }
</style>
