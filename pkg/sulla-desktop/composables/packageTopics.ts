// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { readonly, ref, type Ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export interface PackageTopic {
  key: string; label: string; blurb: string; icon: string; grp: 'job' | 'industry';
  sort_order: number; active: number; package_count: number;
}

type TopicsIpc = Pick<typeof ipcRenderer, 'invoke'>;

/** Window-wide marketplace topic list, loaded once and shared. */
export class PackageTopicsStore {
  private static instance: PackageTopicsStore | null = null;

  /** The single store every component in this window shares. */
  static shared(): PackageTopicsStore {
    if (!PackageTopicsStore.instance) PackageTopicsStore.instance = new PackageTopicsStore(ipcRenderer);

    return PackageTopicsStore.instance;
  }

  readonly topics: Ref<PackageTopic[]> = ref([]);
  private loading: Promise<void> | null = null;

  constructor(private readonly ipc: TopicsIpc) {}

  /** Load topics; concurrent callers share one in-flight request. */
  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async() => {
      const result = await this.ipc.invoke('marketplace-topics');
      if (result && !('error' in result)) this.topics.value = result.topics ?? [];
    })().finally(() => { this.loading = null; });

    return this.loading;
  }

  /** Display label for a topic key, or 'More' when unknown. */
  label(key: string | null | undefined): string {
    return this.topics.value.find(t => t.key === key)?.label ?? 'More';
  }
}

/** @deprecated use PackageTopicsStore.shared().load() */
export function loadPackageTopics(): Promise<void> {
  return PackageTopicsStore.shared().load();
}

export function usePackageTopics() {
  return readonly(PackageTopicsStore.shared().topics);
}

/** @deprecated use PackageTopicsStore.shared().label() */
export function packageTopicLabel(key: string | null | undefined): string {
  return PackageTopicsStore.shared().label(key);
}
