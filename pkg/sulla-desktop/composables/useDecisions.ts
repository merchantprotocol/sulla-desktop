// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed, onMounted, onUnmounted, ref, type Ref } from 'vue';

import type { DecisionRecord } from '@pkg/shared/decisions';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

type DecisionsIpc = Pick<typeof ipcRenderer, 'invoke' | 'on' | 'removeListener'>;

/** Window-wide decisions list: one IPC subscription and one poll timer for every consumer. */
export class DecisionsStore {
  private static instance: DecisionsStore | null = null;

  /** The single store every component in this window shares. */
  static shared(): DecisionsStore {
    if (!DecisionsStore.instance) DecisionsStore.instance = new DecisionsStore(ipcRenderer);

    return DecisionsStore.instance;
  }

  readonly records: Ref<DecisionRecord[]> = ref([]);
  readonly error = ref('');
  private consumers = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private loading = false;
  private readonly changed = () => { this.refresh() };

  constructor(private readonly ipc: DecisionsIpc) {}

  readonly refresh = async(): Promise<void> => {
    if (this.loading) return;
    this.loading = true;
    try { this.records.value = await this.ipc.invoke('decisions:list'); this.error.value = '' } catch { this.error.value = 'Could not refresh decisions. Try again.' } finally { this.loading = false }
  };

  /** First consumer subscribes, loads and starts polling. */
  attach(): void {
    if (++this.consumers === 1) { this.ipc.on('decisions:changed', this.changed); this.refresh(); this.timer = setInterval(() => { this.refresh() }, 3000) }
  }

  /** Last consumer unsubscribes and stops polling. */
  detach(): void {
    if (--this.consumers === 0) { this.ipc.removeListener('decisions:changed', this.changed); clearInterval(this.timer); this.timer = undefined }
  }
}

export function useDecisions() {
  const store = DecisionsStore.shared();

  onMounted(() => store.attach());
  onUnmounted(() => store.detach());
  const pending = computed(() => store.records.value.filter(r => ['pending', 'deferred'].includes(r.status) && r.expiresAt > Date.now()));

  return { records: store.records, pending, error: store.error, refresh: store.refresh };
}
