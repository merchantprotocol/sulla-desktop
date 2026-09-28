import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { DecisionRecord } from '@pkg/shared/decisions';

const records = ref<DecisionRecord[]>([]);
const error = ref('');
let consumers = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let loading = false;
async function refresh() {
  if (loading) return;
  loading = true;
  try { records.value = await ipcRenderer.invoke('decisions:list'); error.value = ''; }
  catch { error.value = 'Could not refresh decisions. Try again.'; }
  finally { loading = false; }
}
const changed = () => { void refresh(); };
export function useDecisions() {
  onMounted(() => {
    if (++consumers === 1) { ipcRenderer.on('decisions:changed', changed); void refresh(); timer = setInterval(() => { void refresh(); }, 3000); }
  });
  onUnmounted(() => { if (--consumers === 0) { ipcRenderer.removeListener('decisions:changed', changed); clearInterval(timer); timer = undefined; } });
  const pending = computed(() => records.value.filter(r => ['pending', 'deferred'].includes(r.status) && r.expiresAt > Date.now()));
  return { records, pending, error, refresh };
}
