// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed, inject, onBeforeUnmount, ref, type Ref } from 'vue';

import { chatDecisions, isOpenDecision } from '../messages/sideDock';

import type { DecisionRecord } from '@pkg/shared/decisions';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

/**
 * This chat's questions and approvals, read from the decisions store the
 * question cards already use and kept current from its change events.
 * Read only: answering still happens on the card itself.
 */
function useChatDecisions(): { decisions: Ref<DecisionRecord[]>; openCount: Ref<number> } {
  const context = inject<{ backendThreadId: Ref<string | undefined> }>('chat:activity-context', { backendThreadId: ref(undefined) });
  const records = ref(new Map<string, DecisionRecord>());

  const put = (record: DecisionRecord | undefined) => {
    if (!record?.id) return;
    const next = new Map(records.value);
    next.set(record.id, record);
    records.value = next;
  };
  const onChanged = (_event: unknown, record: DecisionRecord) => put(record);

  ipcRenderer.invoke('decisions:list' as any)
    .then((list: DecisionRecord[]) => { for (const record of list ?? []) put(record); })
    .catch(() => undefined);
  ipcRenderer.on('decisions:changed' as any, onChanged);
  onBeforeUnmount(() => ipcRenderer.removeListener('decisions:changed' as any, onChanged));

  const decisions = computed(() => chatDecisions([...records.value.values()], [context.backendThreadId.value]));
  const openCount = computed(() => decisions.value.filter(isOpenDecision).length);
  return { decisions, openCount };
}

/** This chat's decisions from the decisions store, and how many are open. */
export class ChatDecisions {
  static readonly useChatDecisions = useChatDecisions;
}
