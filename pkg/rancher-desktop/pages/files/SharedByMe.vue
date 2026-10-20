<template>
  <div class="shared-by-me">
    <div class="toolbar">
      <div><h1>Shared by me</h1><p>Files, captures and Sulla-made items in one place.</p></div>
      <button class="button" type="button" @click="showLog = !showLog">{{ showLog ? 'Hide view log' : 'View log' }}</button>
    </div>
    <div class="controls">
      <label class="search"><span>⌕</span><input v-model="query" placeholder="Search shared links"></label>
      <div class="segments"><button v-for="filter in filters" :key="filter.key" type="button" :class="{ on: kind === filter.key }" @click="kind = filter.key">{{ filter.label }} · {{ filter.count }}</button></div>
      <label class="sort">Sort <select v-model="sort"><option value="viewed">Last viewed</option><option value="created">Newest</option><option value="views">Most views</option><option value="expiry">Expiry</option></select></label>
    </div>
    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="loading" class="state">Loading your links…</div>
    <div v-else-if="!visible.length" class="state">No shared links match this view.</div>
    <div v-else class="table-card">
      <table>
        <thead><tr><th>Item</th><th>Kind</th><th>Views</th><th>Expires</th><th>Keep available</th><th>Served from</th><th /></tr></thead>
        <tbody><tr v-for="item in visible" :key="item.id" :class="{ revoked: item.revokedAt }">
          <td><div class="name"><span class="glyph" :class="item.assetKind">{{ item.assetKind === 'artifact' ? 'S' : item.assetKind === 'capture' ? '⌾' : '◇' }}</span><span><b>{{ item.name }}</b><small>{{ item.url || 'Revoked link' }}</small></span></div></td>
          <td><span class="kind">{{ kindLabel(item.assetKind) }}</span></td>
          <td>{{ item.viewCount.toLocaleString() }}<small v-if="item.lastViewedAt"> · {{ relative(item.lastViewedAt) }}</small></td>
          <td>{{ item.expiresAt ? formatDate(item.expiresAt) : 'Never' }}</td>
          <td><label v-if="!item.revokedAt" class="keep"><input type="checkbox" :aria-label="`Keep ${item.name} available when my computer is off`" :checked="item.keepAvailable" :disabled="busyId === item.id" @change="setKeep(item, ($event.target as HTMLInputElement).checked)"><i aria-hidden="true" /><span>{{ item.keepUntil ? `until ${formatDate(item.keepUntil)}` : item.keepAvailable ? 'on' : 'live only' }}</span></label><span v-else>—</span></td>
          <td><span class="source"><i :class="{ off: Boolean(item.revokedAt) }" />{{ sourceLabel(item) }}</span></td>
          <td><div class="actions"><button v-if="!item.revokedAt" class="button small" type="button" @click="copy(item)">{{ copiedId === item.id ? 'Copied' : 'Copy' }}</button><button v-if="!item.revokedAt" class="button small danger" type="button" :disabled="busyId === item.id" @click="revoke(item)">Revoke</button><input v-if="item.revokedAt && item.password" v-model="restorePasswords[item.id]" class="restore-password" type="password" autocomplete="new-password" placeholder="Link password"><button v-if="item.revokedAt && dataSource.restorePublicLink" class="button small" type="button" :disabled="busyId === item.id" @click="restore(item)">Restore link</button></div></td>
        </tr></tbody>
      </table>
    </div>
    <section v-if="showLog" class="log"><h2>View and download log</h2><div v-if="activityLoading">Loading activity…</div><div v-else-if="!activity.length">No activity recorded yet.</div><div v-for="event in activity" :key="event.id" class="log-row"><b>{{ event.action }}</b><span>{{ event.detail || 'Shared link' }}</span><time>{{ relative(event.occurredAt) }}</time></div></section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import type { FilesDataSource, ShareActivity, ShareAssetKind, ShareLink } from './types';

const props = defineProps<{ dataSource: FilesDataSource }>();
const links = ref<ShareLink[]>([]); const activity = ref<ShareActivity[]>([]); const loading = ref(true); const activityLoading = ref(false); const error = ref(''); const query = ref(''); const kind = ref<'all' | ShareAssetKind>('all'); const sort = ref('viewed'); const busyId = ref(''); const copiedId = ref(''); const showLog = ref(false); const restorePasswords = ref<Record<string, string>>({});
const filters = computed(() => [
  { key: 'all' as const, label: 'All', count: links.value.length },
  { key: 'file' as const, label: 'Files', count: links.value.filter(item => item.assetKind === 'file').length },
  { key: 'capture' as const, label: 'Captures', count: links.value.filter(item => item.assetKind === 'capture').length },
  { key: 'artifact' as const, label: 'Sulla-made', count: links.value.filter(item => item.assetKind === 'artifact').length },
]);
const visible = computed(() => links.value.filter(item => (kind.value === 'all' || item.assetKind === kind.value) && (!query.value.trim() || `${ item.name } ${ item.url } ${ item.source }`.toLowerCase().includes(query.value.trim().toLowerCase()))).sort((a, b) => {
  if (sort.value === 'views') return b.viewCount - a.viewCount;
  if (sort.value === 'created') return Date.parse(b.createdAt || '0') - Date.parse(a.createdAt || '0');
  if (sort.value === 'expiry') return Date.parse(a.expiresAt || '9999-12-31') - Date.parse(b.expiresAt || '9999-12-31');
  return Date.parse(b.lastViewedAt || b.createdAt || '0') - Date.parse(a.lastViewedAt || a.createdAt || '0');
}));

async function load() { loading.value = true; try { links.value = await props.dataSource.listPublicLinks?.() ?? []; error.value = '' } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { loading.value = false } }
async function copy(item:ShareLink) { await navigator.clipboard.writeText(item.url); copiedId.value = item.id; setTimeout(() => { copiedId.value = '' }, 1_400) }
async function revoke(item:ShareLink) { if (!props.dataSource.revokePublicLink) return; busyId.value = item.id; try { await props.dataSource.revokePublicLink(item.id); item.revokedAt = new Date().toISOString() } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { busyId.value = '' } }
async function restore(item:ShareLink) { if (!props.dataSource.restorePublicLink) return; const password = restorePasswords.value[item.id]; if (item.password && (!password || password.length < 8)) { error.value = 'Re-enter the link password to restore this protected share'; return } busyId.value = item.id; try { Object.assign(item, await props.dataSource.restorePublicLink(item.id, password)); delete restorePasswords.value[item.id] } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { busyId.value = '' } }
async function setKeep(item:ShareLink, enabled:boolean) { if (!props.dataSource.updatePublicLink) return; busyId.value = item.id; try { Object.assign(item, await props.dataSource.updatePublicLink(item.id, { keepAvailable: enabled })) } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { busyId.value = '' } }
function kindLabel(value:ShareAssetKind) { return value === 'artifact' ? 'Sulla-made' : value === 'capture' ? 'Capture' : 'File' }
function formatDate(value:string) { return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }
function relative(value:string) { const delta = Date.now() - Date.parse(value); const minutes = Math.floor(delta / 60_000); if (minutes < 1) return 'just now'; if (minutes < 60) return `${ minutes }m ago`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${ hours }h ago`; return formatDate(value) }
function sourceLabel(item:ShareLink) { if (item.revokedAt) return `${ item.source || 'This Mac' } · revoked`; if (item.servedFrom === 'cloud') return 'Copy on Sulla Cloud'; if (item.servedFrom === 'server') return item.source || 'Sulla Server'; return item.source || 'This Mac · live' }
watch(showLog, async(value) => { if (!value || !props.dataSource.shareActivity) return; activityLoading.value = true; try { activity.value = await props.dataSource.shareActivity() } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { activityLoading.value = false } });
onMounted(load);
</script>

<style scoped>
.shared-by-me{font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;color:#1a2332}.toolbar,.controls{display:flex;align-items:center;gap:10px}.toolbar{margin-bottom:12px}.toolbar>div:first-child{flex:1}.toolbar h1{margin:0;font-size:18px;font-weight:650}.toolbar p{margin:2px 0 0;color:#5b6778;font-size:11.5px}.controls{flex-wrap:wrap;margin-bottom:12px}.search{display:flex;align-items:center;gap:6px;min-width:220px;flex:1;padding:6px 9px;border:1px solid rgba(26,35,50,.14);border-radius:8px;background:#fff}.search input{min-width:0;flex:1;border:0;outline:0;font:12px inherit}.segments{display:flex;gap:2px;padding:2px;border:1px solid rgba(26,35,50,.14);border-radius:8px;background:#fff}.segments button{padding:4px 8px;border:0;border-radius:6px;background:transparent;color:#5b6778;font-size:11px}.segments button.on{background:rgba(58,127,160,.1);color:#2f6a86;font-weight:600}.sort{position:relative;padding:5px 9px;border:1px solid rgba(26,35,50,.14);border-radius:8px;background:#fff;color:#8a94a3;font-size:11px}.sort select{border:0;background:transparent;color:#1a2332;font:inherit}.table-card{overflow:auto;border:1px solid rgba(26,35,50,.09);border-radius:12px;background:rgba(255,255,255,.82);box-shadow:0 1px 2px rgba(26,35,50,.04),0 10px 30px -12px rgba(26,35,50,.12)}table{width:100%;border-collapse:collapse}th{padding:8px 12px;border-bottom:1px solid rgba(26,35,50,.09);color:#8a94a3;text-align:left;text-transform:uppercase;white-space:nowrap;font-size:10px;letter-spacing:.06em}td{padding:9px 12px;border-bottom:1px solid rgba(26,35,50,.07);color:#5b6778;white-space:nowrap;font-size:11.5px}tr:last-child td{border:0}tr.revoked td{opacity:.58}tr.revoked td:last-child{opacity:1}.name{display:flex;align-items:center;gap:9px;min-width:240px}.name>span:last-child{min-width:0}.name b,.name small{display:block;max-width:260px;overflow:hidden;text-overflow:ellipsis}.name b{color:#1a2332;font-weight:550}.name small{color:#8a94a3;font:10.5px ui-monospace,monospace}.glyph{display:grid;width:28px;height:28px;place-items:center;border-radius:7px;background:rgba(58,127,160,.1);color:#2f6a86;font-weight:700}.glyph.capture{background:rgba(107,79,191,.12);color:#6b4fbf}.glyph.artifact{background:rgba(26,35,50,.08);color:#1a2332}.kind{font-weight:600}.keep{display:flex;align-items:center;gap:6px}.keep input{accent-color:#3a7fa0}.source{display:flex;align-items:center;gap:7px}.source i{width:7px;height:7px;border-radius:50%;background:#1f9d55;box-shadow:0 0 0 3px rgba(31,157,85,.12)}.source i.off{background:#8a94a3;box-shadow:0 0 0 3px rgba(138,148,163,.16)}.actions{display:flex;gap:4px;justify-content:flex-end}.restore-password{width:108px;padding:3px 6px;border:1px solid rgba(26,35,50,.14);border-radius:7px;font:11px inherit}.button{padding:6px 10px;border:1px solid rgba(26,35,50,.14);border-radius:7px;background:#fff;color:#1a2332;font:500 11.5px inherit}.button.small{padding:3px 7px}.button.danger{border-color:rgba(217,64,58,.35);color:#b1302b}.state,.error{padding:36px;border:1px solid rgba(26,35,50,.09);border-radius:12px;background:rgba(255,255,255,.82);color:#5b6778;text-align:center}.error{margin-bottom:10px;padding:9px;color:#b1302b;background:rgba(217,64,58,.11)}.log{margin-top:12px;padding:12px 14px;border:1px solid rgba(26,35,50,.09);border-radius:12px;background:#fff}.log h2{margin:0 0 8px;font-size:13px}.log-row{display:grid;grid-template-columns:90px 1fr auto;gap:10px;padding:6px 0;border-top:1px solid rgba(26,35,50,.07);font-size:11px}.log-row span,.log-row time{color:#8a94a3}

.keep { position: relative; }
.keep input { position: absolute; width: 34px; height: 20px; margin: 0; opacity: 0; cursor: pointer; }
.keep i { display: inline-block; position: relative; flex: none; width: 34px; height: 20px; border: 1px solid rgba(26,35,50,.14); border-radius: 20px; background: rgba(138,148,163,.16); pointer-events: none; }
.keep i::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(26,35,50,.25); }
.keep input:checked + i { background: #3a7fa0; border-color: #3a7fa0; }
.keep input:checked + i::after { left: 16px; }
.keep input:focus + i { outline: 2px solid #3a7fa0; outline-offset: 2px; }
.keep input:disabled + i { opacity: .5; }
</style>
