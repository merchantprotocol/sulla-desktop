<!--
  Inline patch block: head + body + actions (Apply / Open / Reject).
  Opening a patch spawns a code artifact; applying flips the state and
  dims the body.
-->
<template>
  <div :class="['patch', stateClass]">
    <div class="patch-head">
      <span>Patch</span>
      <span class="path">{{ msg.path }}</span>
      <span class="stat">
        <span class="plus">+{{ msg.stat.added }}</span>
        <span class="minus">−{{ msg.stat.removed }}</span>
      </span>
    </div>
    <div class="patch-body">
      <div
        v-for="(line, idx) in flatLines"
        :key="idx"
        :class="['l', line.op]"
      >
        <span class="n">{{ line.n }}</span>
        <span v-html="line.text" />
      </div>
    </div>
    <div class="patch-actions">
      <template v-if="msg.state === 'proposed'">
        <button class="apply"  type="button" @click="apply">Apply</button>
        <span class="sep">·</span>
        <button class="open"   type="button" @click="open">Open File</button>
        <span class="sep">·</span>
        <button class="reject" type="button" @click="reject">Reject</button>
      </template>
      <template v-else-if="msg.state === 'applied'">
        <button class="open"   type="button" @click="open">Open File</button>
        <template v-if="canRevert">
          <span class="sep">·</span>
          <button class="revert" type="button" :disabled="reverting" @click="revert">
            {{ reverting ? 'Reverting…' : 'Revert' }}
          </button>
        </template>
      </template>
      <template v-else>
        <button class="open"   type="button" @click="open">Open File</button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { PatchMessage } from '../../models/Message';
import type { CodePayload } from '../../models/Artifact';
import { useChatController } from '../../controller/useChatController';

const props = defineProps<{ msg: PatchMessage }>();
const controller = useChatController();

const reverting = ref(false);

const flatLines = computed(() => props.msg.hunks.flatMap(h => h.lines));
const stateClass = computed(() => props.msg.state === 'applied' ? 'applied'
  : props.msg.state === 'rejected' ? 'rejected' : '');
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
    path: props.msg.path,
    language: 'typescript',
    lines: flatLines.value.map(l => ({ n: l.n, text: l.text, op: l.op })),
  };
  controller.openArtifact('code', { name: props.msg.path.split('/').pop(), payload, status: 'editing' });
}
</script>

<style scoped>
.patch {
  margin: 8px 0 0;
  border-left: 1px solid rgba(80, 150, 179, 0.28);
  padding-left: 22px; position: relative;
}
.patch::before {
  content: ""; position: absolute; left: -4px; top: 20px;
  width: 7px; height: 7px; border-radius: 50%;
  background: rgba(80, 150, 179, 0.55);
}
.patch-head {
  font-family: var(--font-mono, ui-monospace, monospace); font-size: 10.5px; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--accent-primary, var(--accent));
  display: flex; align-items: baseline; gap: 14px; margin: 8px 0 10px;
}
.patch-head .path {
  font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px;
  color: var(--text-primary); letter-spacing: 0.02em; text-transform: none;
}
.patch-head .stat { margin-left: auto; font-size: 10px; color: var(--text-secondary); }
.patch-head .stat .plus  { color: var(--text-success); }
.patch-head .stat .minus { color: var(--text-error); margin-left: 6px; }
.patch-body {
  font-family: var(--font-mono, ui-monospace, monospace); font-size: 13px; line-height: 1.7;
  color: var(--text-primary);
  padding: 14px 0 16px;
  border-top: 1px solid rgba(80, 150, 179, 0.18);
  border-bottom: 1px solid rgba(80, 150, 179, 0.18);
}
.patch-body .l { display: flex; gap: 12px; padding: 0 2px; }
.patch-body .l .n { color: var(--text-muted); min-width: 22px; text-align: right; user-select: none; font-size: 11.5px; }
.patch-body .l.add { background: var(--diff-ins-bg, rgba(34, 197, 94, 0.15)); border-radius: 2px; }
.patch-body .l.add .n { color: var(--text-success); }
.patch-body .l.add::before { content: "+ "; color: var(--text-success); margin-left: 2px; }
.patch-body .l.context::before { content: "  "; white-space: pre; }
.patch-body .l.context { color: var(--text-secondary); }
.patch-body .l.remove { background: var(--diff-del-bg, rgba(239, 68, 68, 0.15)); }
.patch-body .l.remove .n { color: var(--text-error); }
.patch-body .l.remove::before { content: "- "; color: var(--text-error); margin-left: 2px; }

.patch-actions {
  display: flex; gap: 14px; margin-top: 14px; align-items: center;
  font-family: var(--font-mono, ui-monospace, monospace); font-size: 10.5px; letter-spacing: 0.2em;
  text-transform: uppercase;
}
.patch-actions button {
  font: inherit; border: none; background: none; cursor: pointer;
  padding: 0; letter-spacing: inherit; text-transform: inherit;
  transition: color 0.15s ease;
}
.patch-actions .apply  { color: var(--text-primary); font-weight: 700; }
.patch-actions .apply:hover { color: var(--accent-primary, var(--accent)); }
.patch-actions .open   { color: var(--accent-primary, var(--accent)); }
.patch-actions .open:hover { color: var(--text-primary); }
.patch-actions .reject { color: var(--text-secondary); }
.patch-actions .reject:hover { color: var(--text-error); }
.patch-actions .revert { color: var(--text-secondary); }
.patch-actions .revert:hover { color: var(--text-error); }
.patch-actions .revert:disabled { color: var(--text-muted); cursor: wait; }
.patch-actions .sep    { color: var(--text-muted); }
.patch.applied .patch-body { opacity: 0.55; }
.patch.applied .patch-head::before { content: "◆ APPLIED · "; color: var(--text-success); letter-spacing: 0.18em; }
.patch.rejected .patch-body { opacity: 0.4; filter: saturate(0.3); }
.patch.rejected .patch-head::before { content: "◇ REJECTED · "; color: var(--text-error); letter-spacing: 0.18em; }
</style>
