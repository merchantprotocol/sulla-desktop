import { readonly, ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export interface PackageTopic {
  key: string; label: string; blurb: string; icon: string; grp: 'job' | 'industry';
  sort_order: number; active: number; package_count: number;
}

const topics = ref<PackageTopic[]>([]);
let loading: Promise<void> | null = null;

export async function loadPackageTopics(): Promise<void> {
  if (loading) return loading;
  loading = (async() => {
    const result = await ipcRenderer.invoke('marketplace-topics');
    if (result && !('error' in result)) topics.value = result.topics ?? [];
  })().finally(() => { loading = null; });

  return loading;
}

export function usePackageTopics() {
  return readonly(topics);
}

export function packageTopicLabel(key: string | null | undefined): string {
  return topics.value.find(t => t.key === key)?.label ?? 'More';
}
