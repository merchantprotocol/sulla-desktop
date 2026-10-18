<template>
  <div class="share-backdrop" @mousedown.self="emit('close')">
    <section class="share-sheet" role="dialog" aria-modal="true" :aria-label="`Share ${target.name}`">
      <header>
        <div class="title"><span class="share-glyph">↗</span><div><h2>Share {{ target.name }}</h2><p>{{ target.folder ? 'Manage member and group access.' : 'Manage access and a public Sulla Cloud link.' }}</p></div></div>
        <button class="icon-button" type="button" aria-label="Close" @click="emit('close')">×</button>
      </header>

      <div v-if="loading" class="sheet-state"><span class="spinner" /> Loading sharing settings…</div>
      <template v-else>
        <div v-if="error" class="sheet-error" role="alert">{{ error }}</div>

        <section v-if="canManageMembers" class="block">
          <div class="block-title"><b>People and groups</b><span>{{ currentShares.length }} with access</span></div>
          <div v-for="share in currentShares" :key="`${share.principalType}:${share.principalId}`" class="access-row">
            <span class="avatar">{{ initials(share.principalName || share.principalId) }}</span>
            <div class="access-name"><b>{{ share.principalName || share.principalId }}</b><small>{{ share.principalType === 'group' ? 'Group' : 'Member' }}</small></div>
            <select :value="share.role" :disabled="busy" @change="changeRole(share, ($event.target as HTMLSelectElement).value as 'view' | 'edit')"><option value="view">Can view</option><option value="edit">Can edit</option></select>
            <button class="remove" type="button" :disabled="busy" @click="removeShare(share)">Remove</button>
          </div>
          <div class="invite-row">
            <select v-model="principalId" aria-label="Member or group">
              <option value="">Choose a member or group</option>
              <optgroup v-if="memberPrincipals.length" label="Members"><option v-for="principal in memberPrincipals" :key="principal.id" :value="principalKey(principal)">{{ principal.name }}</option></optgroup>
              <optgroup v-if="groupPrincipals.length" label="Groups"><option v-for="principal in groupPrincipals" :key="principal.id" :value="principalKey(principal)">{{ principal.name }}</option></optgroup>
            </select>
            <select v-model="principalRole" aria-label="Access role"><option value="view">Can view</option><option value="edit">Can edit</option></select>
            <button class="button" type="button" :disabled="!principalId || busy" @click="addPrincipal">Add</button>
          </div>
        </section>

        <section v-if="!target.folder" class="block public-block">
          <div class="public-heading"><div><b>Public link</b><span>Served through Sulla Cloud</span></div><label class="switch"><input v-model="publicEnabled" type="checkbox" :disabled="busy || Boolean(link?.revokedAt)"><i /></label></div>
          <p v-if="!publicEnabled && !link" class="explain">Off. Nothing is public until you enable this.</p>
          <template v-else-if="link || publicEnabled">
            <div v-if="link" class="url-row"><code>{{ link.url }}</code><button class="button primary" type="button" :disabled="busy || Boolean(link.revokedAt)" @click="copy">{{ copied ? 'Copied' : 'Copy link' }}</button></div>
            <div class="policy-row"><div><b>Visitors can</b><small>Choose view only or allow download</small></div><div class="seg"><button type="button" :class="{ on: mode === 'view' }" @click="mode = 'view'">View</button><button type="button" :class="{ on: mode === 'download' }" @click="mode = 'download'">Download</button></div></div>
            <div class="policy-row"><div><b>Password</b><small>{{ removePassword ? 'Will be removed' : password || link?.password ? 'Required to open' : 'Not set' }}</small></div><button v-if="link?.password && !removePassword && !link.revokedAt" class="text-button" type="button" @click="removePassword = true; password = ''">Remove</button><input v-else v-model="password" class="field" type="password" autocomplete="new-password" :placeholder="link?.revokedAt && link.password ? 'Re-enter to restore' : 'At least 8 characters'"></div>
            <div class="policy-row"><div><b>Expires</b><small>Link stops working after this date</small></div><input v-model="expiresAt" class="field" type="date" :min="tomorrow"></div>
            <div class="policy-row"><div><b>Display my name</b><small>Show who shared this item</small></div><label class="switch"><input v-model="displaySharerName" type="checkbox"><i /></label></div>
            <div class="policy-row keep"><div><b>Keep available when my computer is off</b><small>Store a temporary encrypted copy on Sulla Cloud until the earlier of Keep until, expiry, or revoke.</small></div><label class="switch"><input v-model="keepAvailable" type="checkbox"><i /></label></div>
            <div v-if="keepAvailable" class="policy-row"><div><b>Keep until</b><small>Cloud copy is removed after this date</small></div><input v-model="keepUntil" class="field" type="date" :min="tomorrow"></div>
            <div v-if="link" class="stats"><span><b>{{ link.viewCount }}</b> views</span><span><b>{{ link.lastViewedAt ? relative(link.lastViewedAt) : 'Never' }}</b> last viewed</span><button class="text-button" type="button" @click="showLog = !showLog">{{ showLog ? 'Hide log' : 'View log' }}</button></div>
            <div v-if="showLog" class="activity"><div v-if="activityLoading">Loading activity…</div><div v-else-if="!activity.length">No link activity yet.</div><div v-for="event in activity" :key="event.id"><b>{{ event.action }}</b><span>{{ relative(event.occurredAt) }}<template v-if="event.detail"> · {{ event.detail }}</template></span></div></div>
          </template>
        </section>
      </template>

      <footer>
        <button v-if="link && !link.revokedAt" class="button danger" type="button" :disabled="busy" @click="revoke">Revoke link</button>
        <button v-else-if="link?.revokedAt && dataSource.restorePublicLink" class="button" type="button" :disabled="busy" @click="restore">Restore link</button>
        <span class="spacer" />
        <button class="button" type="button" @click="emit('close')">Cancel</button>
        <button class="button primary" type="button" :disabled="busy || loading" @click="save">{{ busy ? 'Saving…' : 'Done' }}</button>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import type { FilesDataSource, FolderShare, ShareActivity, ShareLink, SharePrincipal } from './types';

const props = defineProps<{
  dataSource: FilesDataSource;
  target: { id: string; name: string; folder: boolean; path: string; collectionId: string; orgId?: string; ownerUserId?: string; assetKind?:'file' | 'capture' | 'artifact' };
}>();
const emit = defineEmits<{ close: []; updated: [link?:ShareLink] }>();

const loading = ref(true); const busy = ref(false); const error = ref(''); const copied = ref(false);
const currentShares = ref<FolderShare[]>([]); const principals = ref<SharePrincipal[]>([]); const principalId = ref(''); const principalRole = ref<'view' | 'edit'>('view');
const link = ref<ShareLink>(); const publicEnabled = ref(false); const mode = ref<'view' | 'download'>('view'); const password = ref(''); const removePassword = ref(false); const expiresAt = ref('');
const displaySharerName = ref(true); const keepAvailable = ref(false); const keepUntil = ref(''); const showLog = ref(false); const activity = ref<ShareActivity[]>([]); const activityLoading = ref(false);
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const canManageMembers = computed(() => props.target.folder && props.target.orgId && props.dataSource.listMembers && props.dataSource.shareFolder);
const memberPrincipals = computed(() => principals.value.filter(item => item.type === 'user'));
const groupPrincipals = computed(() => principals.value.filter(item => item.type === 'group'));
const principalKey = (principal:SharePrincipal) => `${ principal.type }:${ principal.id }`;

function dateValue(value?:string) { return value ? new Date(value).toISOString().slice(0, 10) : '' }
function dateTime(value:string) { return value ? new Date(`${ value }T23:59:59.999Z`).toISOString() : null }
function applyLink(value:ShareLink) { link.value = value; publicEnabled.value = !value.revokedAt; mode.value = value.mode; expiresAt.value = dateValue(value.expiresAt); displaySharerName.value = value.displaySharerName; keepAvailable.value = value.keepAvailable; keepUntil.value = dateValue(value.keepUntil) }
function initials(value:string) { return value.split(/[@\s._-]+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '?' }
function relative(value:string) { const difference = Date.now() - Date.parse(value); const minutes = Math.floor(difference / 60_000); if (minutes < 1) return 'just now'; if (minutes < 60) return `${ minutes }m ago`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${ hours }h ago`; return new Date(value).toLocaleDateString() }

async function load() {
  loading.value = true; error.value = '';
  try {
    if (!props.target.folder && props.dataSource.listPublicLinks) {
      // Names are display metadata, not identity. Two folders can contain files
      // with the same basename; binding by name could expose or revoke the other
      // file's public link from this sheet.
      const links = await props.dataSource.listPublicLinks(); const existing = links.find(item => item.targetId === props.target.id);
      if (existing) applyLink(existing);
    }
    if (canManageMembers.value) {
      const [directory, shares] = await Promise.all([
        props.dataSource.listMembers!(props.target.orgId!),
        props.dataSource.listFolderShares?.(props.target.collectionId) ?? Promise.resolve([]),
      ]);
      principals.value = [
        ...directory.members.filter(member => member.id !== props.target.ownerUserId).map(member => ({ id: member.id, type: 'user' as const, name: member.email, detail: member.role })),
        ...(directory.groups ?? []).map(group => ({ id: group.id, type: 'group' as const, name: group.name || group.encrypted_name || 'Encrypted group', detail: `${ group.members?.length ?? 0 } members` })),
      ];
      currentShares.value = shares.filter(share => share.folderPath === props.target.path).map(share => ({ ...share, principalName: principals.value.find(item => item.id === share.principalId && item.type === share.principalType)?.name }));
    }
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { loading.value = false }
}

async function addPrincipal() {
  const [principalType, id] = principalId.value.split(':') as ['user' | 'group', string]; if (!id || !props.dataSource.shareFolder) return;
  busy.value = true; error.value = '';
  try { const share = await props.dataSource.shareFolder(props.target.collectionId, props.target.path, principalType, id, principalRole.value); const principal = principals.value.find(item => item.id === id && item.type === principalType); currentShares.value = [...currentShares.value.filter(item => !(item.principalType === principalType && item.principalId === id)), { ...share, principalName: principal?.name }]; principalId.value = '' } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { busy.value = false }
}
async function changeRole(share:FolderShare, role:'view' | 'edit') { if (!props.dataSource.shareFolder) return; busy.value = true; try { await props.dataSource.shareFolder(share.collectionId, share.folderPath, share.principalType, share.principalId, role); share.role = role } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { busy.value = false } }
async function removeShare(share:FolderShare) { if (!props.dataSource.unshareFolder) return; busy.value = true; try { await props.dataSource.unshareFolder(share); currentShares.value = currentShares.value.filter(item => item !== share) } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { busy.value = false } }
async function copy() { if (!link.value?.url) return; await navigator.clipboard.writeText(link.value.url); copied.value = true; setTimeout(() => { copied.value = false }, 1_500) }
async function revoke() { if (!link.value || !props.dataSource.revokePublicLink) return; busy.value = true; try { await props.dataSource.revokePublicLink(link.value.id); link.value = { ...link.value, revokedAt: new Date().toISOString() }; publicEnabled.value = false; emit('updated', link.value) } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { busy.value = false } }
async function restore() { if (!link.value || !props.dataSource.restorePublicLink) return; if (link.value.password && password.value.length < 8) { error.value = 'Re-enter the link password to restore this protected share'; return } busy.value = true; try { applyLink(await props.dataSource.restorePublicLink(link.value.id, password.value || undefined)); password.value = ''; emit('updated', link.value) } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { busy.value = false } }
async function save() {
  if (props.target.folder) { emit('updated'); emit('close'); return }
  busy.value = true; error.value = '';
  try {
    if (!publicEnabled.value) { if (link.value && !link.value.revokedAt) await revoke(); emit('close'); return }
    const options = { mode: mode.value, password: removePassword.value ? '' : password.value || undefined, expiresAt: dateTime(expiresAt.value), displaySharerName: displaySharerName.value, keepAvailable: keepAvailable.value, keepUntil: keepAvailable.value ? dateTime(keepUntil.value) : null, assetKind: props.target.assetKind ?? 'file' };
    const value = link.value && !link.value.revokedAt && props.dataSource.updatePublicLink ? await props.dataSource.updatePublicLink(link.value.id, options) : await props.dataSource.createPublicLink!(props.target.id, options);
    applyLink(value); await copy(); emit('updated', value); emit('close');
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { busy.value = false }
}

watch(showLog, async(value) => { if (!value || !props.dataSource.shareActivity) return; activityLoading.value = true; try { activity.value = await props.dataSource.shareActivity(link.value?.id) } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { activityLoading.value = false } });
onMounted(load);
</script>

<style scoped>
.share-backdrop{position:absolute;z-index:50;inset:0;display:grid;place-items:center;padding:24px;background:rgba(26,35,50,.28);backdrop-filter:blur(3px);font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}.share-sheet{width:min(620px,100%);max-height:calc(100% - 24px);overflow:auto;border:1px solid rgba(26,35,50,.1);border-radius:14px;background:#fff;color:#1a2332;box-shadow:0 30px 70px -24px rgba(26,35,50,.45)}header,footer{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(26,35,50,.09)}footer{position:sticky;bottom:0;border-top:1px solid rgba(26,35,50,.09);border-bottom:0;background:rgba(255,255,255,.96)}.title{display:flex;gap:10px;align-items:center;flex:1}.title h2{margin:0;font-size:16px;font-weight:650}.title p{margin:2px 0 0;color:#5b6778;font-size:11.5px}.share-glyph{display:grid;width:30px;height:30px;place-items:center;border-radius:8px;background:rgba(58,127,160,.1);color:#2f6a86;font-weight:700}.icon-button{border:0;background:transparent;color:#8a94a3;font-size:22px}.block{padding:14px 16px;border-bottom:1px solid rgba(26,35,50,.09)}.block-title,.public-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.block-title b,.public-heading b{font-size:12.5px}.block-title span,.public-heading span{display:block;color:#8a94a3;font-size:10.5px}.access-row{display:flex;align-items:center;gap:9px;padding:8px 0;border-top:1px solid rgba(26,35,50,.07)}.avatar{display:grid;width:28px;height:28px;place-items:center;border-radius:50%;background:linear-gradient(135deg,#9ec1d3,#3a7fa0);color:#fff;font-size:9px;font-weight:700}.access-name{min-width:0;flex:1}.access-name b,.access-name small{display:block}.access-name b{font-size:12px;font-weight:550}.access-name small{color:#8a94a3;font-size:10.5px}select,.field{padding:6px 8px;border:1px solid rgba(26,35,50,.14);border-radius:7px;background:#fff;color:#1a2332;font:11.5px inherit}.remove,.text-button{border:0;background:transparent;color:#b1302b;font-size:11px}.invite-row{display:grid;grid-template-columns:1fr auto auto;gap:8px;margin-top:10px}.button{padding:6px 11px;border:1px solid rgba(26,35,50,.14);border-radius:8px;background:#fff;color:#1a2332;font:500 12px inherit}.button.primary{border-color:#3a7fa0;background:#3a7fa0;color:#fff}.button.danger{border-color:rgba(217,64,58,.35);color:#b1302b}.button:disabled{opacity:.55}.spacer{flex:1}.switch input{position:absolute;opacity:0}.switch i{display:block;position:relative;width:34px;height:20px;border-radius:999px;background:rgba(138,148,163,.16);border:1px solid rgba(26,35,50,.14)}.switch i:after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(26,35,50,.25);transition:left .15s}.switch input:checked+i{background:#3a7fa0;border-color:#3a7fa0}.switch input:checked+i:after{left:16px}.explain{margin:0;color:#5b6778;font-size:11.5px}.url-row{display:flex;gap:8px;margin-bottom:8px}.url-row code{min-width:0;flex:1;overflow:hidden;padding:7px 9px;border:1px solid rgba(26,35,50,.14);border-radius:7px;background:#f4f7fb;color:#2f6a86;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.policy-row{display:flex;align-items:center;gap:12px;padding:9px 0;border-top:1px solid rgba(26,35,50,.07)}.policy-row>div:first-child{min-width:0;flex:1}.policy-row b,.policy-row small{display:block}.policy-row b{font-size:12px;font-weight:550}.policy-row small{color:#8a94a3;font-size:10.5px}.policy-row.keep{padding:10px;margin:4px -6px 0;border-radius:8px;background:#f4f7fb}.seg{display:flex;padding:2px;border:1px solid rgba(26,35,50,.14);border-radius:8px}.seg button{padding:4px 9px;border:0;border-radius:6px;background:transparent;color:#5b6778;font-size:11px}.seg button.on{background:rgba(58,127,160,.1);color:#2f6a86;font-weight:600}.stats{display:flex;align-items:center;gap:18px;padding-top:10px;color:#5b6778;font-size:10.5px}.stats b{color:#1a2332}.stats .text-button{margin-left:auto;color:#2f6a86}.activity{max-height:120px;overflow:auto;margin-top:8px;padding:8px 10px;border-radius:8px;background:#f4f7fb;font-size:10.5px}.activity>div{display:flex;justify-content:space-between;padding:4px 0}.activity span{color:#8a94a3}.sheet-state{display:flex;align-items:center;gap:9px;padding:28px;color:#5b6778}.spinner{width:16px;height:16px;border:2px solid rgba(58,127,160,.15);border-top-color:#3a7fa0;border-radius:50%;animation:spin .8s linear infinite}.sheet-error{margin:12px 16px 0;padding:8px 10px;border-radius:8px;background:rgba(217,64,58,.11);color:#b1302b;font-size:11.5px}@keyframes spin{to{transform:rotate(360deg)}}
</style>
