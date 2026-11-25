<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  The shared shape for transcript work blocks (thinking, patches, errors):
  one line by default (kind icon, a title saying what happened, the agent and
  model that produced it, a technical meta), with the full detail one click
  away. Slots: `title`, `meta`, `default` (the expanded body), `after` (always
  visible, for actions that must not hide behind a click).
-->
<template>
  <section
    class="wb"
    :class="[`wb-${tone}`, { 'wb-open': open }]"
  >
    <button
      type="button"
      class="wb-head"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span
        class="wb-icon"
        aria-hidden="true"
      ><span
        v-if="live"
        class="wb-live"
      /><template v-else>{{ icon }}</template></span>
      <span class="wb-title"><slot name="title" /></span>
      <span
        v-if="authorName || model"
        class="wb-by"
        :title="`Produced by ${authorName || 'Sulla'}${model ? ` on ${model}` : ''}`"
      >
        <i aria-hidden="true">{{ (authorName || 'S').charAt(0).toUpperCase() }}</i>{{ authorName || 'Sulla' }}<small v-if="model">{{ model }}</small>
      </span>
      <span class="wb-meta"><time
        v-if="when?.label"
        class="wb-time"
        :title="when.full"
      >{{ when.label }} · </time><slot name="meta" /></span>
      <span
        class="wb-chev"
        aria-hidden="true"
      >▸</span>
    </button>
    <div
      v-if="open"
      class="wb-body"
    >
      <slot />
    </div>
    <slot name="after" />
  </section>
</template>

<script setup lang="ts">
import { computed, inject, ref } from 'vue';

import { ModelSelectorKey } from '../../controller/useChatController';
import { LineTimes } from '../../messages/lineTime';

import { AgentModelStatus, type AgentModelStatusValue } from '@pkg/shared/agentState/AgentModelStatus';

const props = withDefaults(defineProps<{
  icon:         string;
  tone:         'think' | 'patch' | 'tool' | 'err';
  by?:          { agent?: string; model?: string; modelStatus?: AgentModelStatusValue };
  live?:        boolean;
  defaultOpen?: boolean;
  /** The transcript line this block is, for its time. */
  lineId?:      string;
}>(), { by: undefined, live: false, defaultOpen: false, lineId: undefined });

const open = ref(props.defaultOpen);
const selector = inject(ModelSelectorKey, null);
/** The agent's display name when the agent list knows it, else its id. */
const authorName = computed(() => {
  const id = props.by?.agent;
  if (!id) return '';
  return selector?.agentOptions.value.find(agent => agent.slug === id)?.name ?? id;
});

/** "Default" and "Auto" are picker labels, not models; older blocks were stamped with them. */
const model = computed(() => props.by?.modelStatus ? AgentModelStatus.label(props.by.modelStatus) : (props.by?.model && !/^(default|auto)$/i.test(props.by.model) ? `${ props.by.model } · Effort not reported` : ''));
const lineTime = LineTimes.useLineTime();
const when = computed(() => (props.lineId ? lineTime(props.lineId) : undefined));

defineExpose({ open });
</script>

<style scoped>
/* Component-prefixed classes: themes restyle generic names. */
.wb {
  --wb-ink-2: color-mix(in srgb, var(--text-primary) 78%, var(--bg-surface));
  --wb-ink-3: color-mix(in srgb, var(--text-primary) 58%, var(--bg-surface));
  --wb-raised: color-mix(in srgb, var(--bg-surface) 55%, var(--bg-page));
  margin: 8px 0; overflow: hidden;
  border: 1px solid var(--border-default); border-radius: 10px;
  background: color-mix(in srgb, var(--bg-page) 55%, transparent);
  color: var(--text-primary); font-family: var(--font-body);
}
.wb-head {
  display: grid; grid-template-columns: 22px minmax(0, 1fr) auto auto auto; gap: 10px; align-items: center;
  width: 100%; padding: 8px 12px; border: 0; background: none; text-align: left; cursor: pointer;
  color: var(--wb-ink-2); font-family: inherit; font-size: 13px;
}
.wb-head:hover { background: color-mix(in srgb, var(--text-primary) 4%, transparent); }
.wb-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.wb-icon { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; font: 600 11px var(--font-mono, ui-monospace, monospace); }
.wb-think .wb-icon { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--primary-color-text-override, var(--accent)); }
.wb-patch .wb-icon { background: color-mix(in srgb, var(--status-success) 14%, transparent); color: var(--status-success); }
.wb-tool .wb-icon { background: color-mix(in srgb, var(--text-primary) 8%, transparent); color: var(--wb-ink-2); }
.wb-err .wb-icon { background: color-mix(in srgb, var(--status-error) 14%, transparent); color: var(--status-error); }
.wb-live { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: wb-pulse 1.6s cubic-bezier(.22,1,.36,1) infinite; }
@keyframes wb-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); }
  70% { box-shadow: 0 0 0 6px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.wb-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb-title :deep(b) { color: var(--text-primary); font-weight: 600; }
.wb-by {
  display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border-radius: 999px;
  border: 1px solid var(--border-default); color: var(--wb-ink-2); font-size: 11.5px; white-space: nowrap;
}
.wb-by i { display: grid; place-items: center; width: 14px; height: 14px; border-radius: 50%; background: var(--accent); color: var(--primary-color-on-override, var(--bg-page)); font: 700 8px var(--font-body); font-style: normal; }
.wb-by small { color: var(--wb-ink-3); font: 11px var(--font-mono, ui-monospace, monospace); }
.wb-meta { color: var(--wb-ink-3); font: 12px var(--font-mono, ui-monospace, monospace); white-space: nowrap; }
.wb-chev { color: var(--wb-ink-3); transition: transform .18s cubic-bezier(.22,1,.36,1); }
.wb-open .wb-chev { transform: rotate(90deg); }
.wb-body { padding: 4px 12px 12px 44px; border-top: 1px solid var(--border-default); }
@media (max-width: 640px) {
  .wb-head { grid-template-columns: 22px minmax(0, 1fr) auto; }
  .wb-by { grid-column: 2; grid-row: 2; justify-self: start; }
  .wb-meta { grid-column: 2; grid-row: 3; }
  .wb-body { padding-left: 12px; }
}
@media (prefers-reduced-motion: reduce) { .wb-live { animation: none; } .wb-chev { transition: none; } }
</style>
