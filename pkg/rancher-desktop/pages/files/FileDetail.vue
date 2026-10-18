<template>
  <main class="file-detail-main">
    <div class="detail-top">
      <div class="crumbs"><button type="button" @click="emit('close')">My Files</button><template v-for="crumb in pathCrumbs" :key="crumb"><span>›</span><span>{{ crumb }}</span></template></div>
      <div class="title"><span class="file-glyph" v-html="fileIcon(item.mime)" /><b>{{ name }}</b></div>
      <div class="top-actions">
        <button class="btn ghost ico" type="button" title="Back to files" @click="emit('close')"><span class="bi" v-html="icons.previous" /></button>
        <button class="btn" type="button" :disabled="busy" @click="download"><span class="bi" v-html="icons.download" /> Download</button>
        <button v-if="activeLink" class="btn" type="button" @click="copyLink"><span class="bi" v-html="icons.link" /> {{ copied ? 'Copied' : 'Copy link' }}</button>
        <button class="btn primary" type="button" :disabled="!dataSource.capabilities.publicLinks" @click="emit('share')"><span class="bi" v-html="icons.share" /> Share</button>
      </div>
    </div>

    <div class="detail-content">
      <div v-if="error" class="error">{{ error }}</div>
      <div class="detail-grid">
        <section class="card preview-card">
          <div class="player">
            <video v-if="mediaUrl && item.mime.startsWith('video/')" ref="video" :src="mediaUrl" controls preload="metadata" />
            <audio v-else-if="mediaUrl && item.mime.startsWith('audio/')" ref="audio" :src="mediaUrl" controls preload="metadata" />
            <img v-else-if="mediaUrl && item.mime.startsWith('image/')" :src="mediaUrl" :alt="name">
            <iframe v-else-if="mediaUrl && item.mime === 'application/pdf'" :src="mediaUrl" :title="name" sandbox="" />
            <div v-else-if="dataSource.syntheticPreview" class="synthetic-frame" aria-label="Synthetic media preview"><div class="window"><i /><i /><i /><div class="sidebar" /><div class="lines" /></div><span class="play" v-html="icons.play" /></div>
            <div v-else class="preview-unavailable"><span class="unavailable-icon" v-html="fileIcon(item.mime)" /><b>Preview unavailable</b><small>{{ previewStatus }}</small></div>
          </div>
          <div class="preview-bar">
            <div class="seg"><button v-for="tab in mediaTabs" :key="tab" type="button" :class="{ on: mediaTab === tab }" @click="mediaTab = tab">{{ tab }}</button></div>
            <span class="meta">{{ mediaMeta }}</span><span class="pill" :class="item.syncState === 'online-only' ? 'idle' : 'ok'">{{ syncLabel }}</span>
          </div>
          <div class="media-pane">
            <template v-if="mediaTab === 'Preview'">
              <h3>Preview <span class="muted">{{ item.mime }}</span></h3><p v-if="mediaUrl && item.mime === 'application/pdf'" class="preview-note">This PDF preview is sandboxed. Download the file if it cannot be displayed.</p><p v-else class="preview-note">{{ mediaUrl ? 'Use the player above to review this file.' : previewStatus }}</p><button v-if="mediaUrl && item.mime === 'application/pdf'" class="btn sm" type="button" :disabled="busy" @click="download">Download PDF</button>
            </template>
            <template v-else-if="mediaTab === 'Transcript'">
              <h3>Transcript <span class="pill idle">{{ detail?.recording?.generator || 'Not generated' }}</span><small>Click a time to jump</small></h3>
              <div v-if="transcript.length" class="timeline"><template v-for="segment in transcript" :key="segment.start"><button type="button" @click="seek(segment.start)">{{ duration(segment.start) }}</button><p>{{ segment.text }}</p></template></div>
              <p v-else class="empty">No transcript is available for this version.</p>
            </template>
            <template v-else>
              <h3>Chapters <span class="pill idle">{{ chapters.length }}</span></h3>
              <div v-if="chapters.length" class="chapters"><button v-for="chapter in chapters" :key="chapter.start" type="button" @click="seek(chapter.start)"><b>{{ chapter.title }}</b><span>{{ duration(chapter.start) }}–{{ duration(chapter.end) }}</span></button></div>
              <p v-else class="empty">No chapters are available for this version.</p>
            </template>
          </div>
        </section>

        <aside class="side">
          <section class="card side-card">
            <div class="tabs"><button v-for="tab in sideTabs" :key="tab" type="button" :class="{ on: sideTab === tab }" @click="sideTab = tab">{{ tab }}<span v-if="tab === 'Versions'" class="tag">{{ versions.length || item.versionCount }}</span></button></div>
            <div v-if="loading" class="pane state">Loading file details…</div>
            <div v-else-if="sideTab === 'Details'" class="pane">
              <dl class="kv"><dt>Type</dt><dd>{{ item.mime }}</dd><dt>Size</dt><dd>{{ formatBytes(item.size) }}</dd><dt v-if="detail?.recording?.duration_seconds">Length</dt><dd v-if="detail?.recording?.duration_seconds">{{ duration(detail.recording.duration_seconds) }}</dd><dt>Location</dt><dd>My Files › {{ pathCrumbs.join(' › ') }}</dd><dt>Owner</dt><dd>{{ owner }}</dd><dt>Modified</dt><dd>{{ formatDate(item.updatedAt) }}</dd><dt>Sync</dt><dd>{{ syncLabel }} <button v-if="item.syncState === 'online-only' && dataSource.capabilities.onlineOnly && dataSource.keepOnMac" class="link" type="button" @click="keepOnMac">Keep on this computer</button></dd><dt>Public link</dt><dd><template v-if="activeLink"><span class="pill ok">On</span> {{ activeLink.viewCount }} views<template v-if="activeLink.expiresAt"> · expires {{ shortDate(activeLink.expiresAt) }}</template></template><span v-else>Off</span></dd></dl>
              <div class="section"><h4>Made by</h4><div class="provenance"><span class="agent">S</span><div><b>{{ provenanceTitle }}</b><small>{{ provenanceDetail }}</small></div></div></div>
              <div v-if="detail?.links.length" class="section"><h4>Linked files</h4><div class="links"><button v-for="link in detail.links" :key="`${link.id}-${link.direction}`" type="button" @click="emit('open-linked', link.id)"><span class="file-glyph small" v-html="fileIcon(link.mime)" /><span>{{ link.path.split('/').at(-1) }}</span><small>{{ link.direction === 'incoming' ? 'links here' : link.kind.replaceAll('_', ' ') }}</small></button></div></div>
            </div>
            <div v-else-if="sideTab === 'Versions'" class="pane versions">
              <div v-for="(version, index) in versions" :key="version.id" class="version"><span class="version-number" :class="{ current: version.current }">v{{ versions.length - index }}</span><div><b>{{ version.message || 'File updated' }}</b><small>{{ formatDate(version.created_at) }} · {{ version.created_by_id }} · {{ formatBytes(version.size) }}</small></div><span v-if="version.current" class="pill ok">Current</span><button v-else-if="!version.deleted" class="btn sm" type="button" :disabled="busy" @click="restore(version.id)">Restore</button></div>
              <p class="note">Restoring makes a new version. Nothing is overwritten.</p>
            </div>
            <div v-else-if="sideTab === 'Access'" class="pane">
              <div class="person"><span class="avatar">{{ initials(owner) }}</span><div><b>{{ owner }}</b><small>Direct collection access</small></div><span>{{ detail?.access.role || 'Can view' }}</span></div>
              <div v-for="grant in detail?.access.inherited || []" :key="grant.id" class="person"><span class="avatar alt">{{ initials(grant.principal_id) }}</span><div><b>{{ grant.principal_id }}</b><small>via {{ grant.folder_path }}</small></div><span>Can {{ grant.role }}</span></div>
              <div v-if="activeLink" class="section"><h4>Public link</h4><div class="provenance"><span class="agent">⌁</span><div><b>{{ activeLink.url.replace(/^https?:\/\//, '') }}</b><small>{{ activeLink.mode }} only · {{ activeLink.password ? 'password · ' : '' }}{{ activeLink.viewCount }} views</small></div></div><div class="link-actions"><button class="btn sm" type="button" @click="copyLink">Copy</button><button class="btn sm" type="button" @click="emit('share')">Settings</button><button class="btn sm danger" type="button" @click="revoke">Revoke</button></div></div>
              <button class="btn share-people" type="button" :disabled="!dataSource.capabilities.publicLinks" @click="emit('share')"><span class="bi" v-html="icons.share" /> Share with people</button>
            </div>
            <div v-else class="pane activity">
              <div v-for="event in allActivity" :key="event.id" class="activity-row"><span class="activity-icon">{{ initials(event.who) }}</span><div><b>{{ event.who }}</b> {{ activityLabel(event.action) }}<small>{{ formatDate(event.at) }}<template v-if="event.detail"> · {{ event.detail }}</template></small></div></div>
              <p v-if="!allActivity.length" class="empty">No activity has been recorded yet.</p>
            </div>
          </section>
        </aside>
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import type { FilesDataSource, FilesDetail, FilesItem, FilesSnapshot, FilesVersion, ShareActivity, ShareLink } from './types';

const props = defineProps<{ item:FilesItem; dataSource:FilesDataSource; collection:FilesSnapshot['collection']; initialTab?:'Details' | 'Versions' }>();
const emit = defineEmits<{ close:[]; share:[]; restored:[]; 'open-linked':[fileId:string] }>();
const detail = ref<FilesDetail>(); const versions = ref<FilesVersion[]>([]); const links = ref<ShareLink[]>([]); const linkActivity = ref<ShareActivity[]>([]); const mediaUrl = ref(''); const loading = ref(true); const busy = ref(false); const error = ref(''); const copied = ref(false);
const previewError = ref('');
const mediaTab = ref<'Preview' | 'Transcript' | 'Chapters'>('Preview'); const sideTab = ref<'Details' | 'Versions' | 'Access' | 'Activity'>(props.initialTab || 'Details'); const video = ref<HTMLVideoElement>(); const audio = ref<HTMLAudioElement>();
const mediaTabs = ['Preview', 'Transcript', 'Chapters'] as const; const sideTabs = ['Details', 'Versions', 'Access', 'Activity'] as const;
const name = computed(() => props.item.path.split('/').at(-1) || props.item.path); const pathCrumbs = computed(() => props.item.path.split('/').slice(0, -1));
const transcript = computed(() => detail.value?.recording?.transcript || []); const chapters = computed(() => detail.value?.recording?.chapters || []);
const activeLink = computed(() => links.value.find(link => !link.revokedAt && (!link.expiresAt || Date.parse(link.expiresAt) > Date.now()) && link.targetId === props.item.id && (!link.targetType || link.targetType === 'file') && (!link.collectionId || link.collectionId === props.collection.id))); const owner = computed(() => props.item.ownerDisplayName || props.collection.accountName || props.item.createdById || 'Unknown owner');
const syncLabel = computed(() => props.item.syncState === 'online-only' ? 'Online only · streams from server' : props.collection.home === 'synced' ? 'Synced with server' : 'Kept on this computer');
const mediaMeta = computed(() => detail.value?.recording?.duration_seconds ? `${ duration(detail.value.recording.duration_seconds) } · ${ detail.value.recording.language?.toUpperCase() || 'Auto' } transcript` : `${ formatBytes(props.item.size) } · ${ props.item.mime }`);
const supportsMedia = computed(() => /^(?:video\/|audio\/)/i.test(props.item.mime) || /^(?:image\/(?:avif|gif|jpeg|png|webp)|application\/pdf)(?:;|$)/i.test(props.item.mime));
const previewStatus = computed(() => previewError.value || (supportsMedia.value ? 'A preview could not be loaded for this file.' : 'This file type does not have an inline preview.'));
const provenanceTitle = computed(() => props.item.createdByType === 'agent-run' ? `Sulla · ${ props.item.createdById }` : owner.value); const provenanceDetail = computed(() => detail.value?.recording ? `Transcribed by ${ detail.value.recording.generator || 'Sulla' } on ${ formatDate(detail.value.recording.generated_at || props.item.updatedAt) }.` : `Created by ${ detail.value?.provenance.id || props.item.createdById }.`);
const allActivity = computed(() => [...(detail.value?.activity || []).map(event => ({ id: event.id, who: event.who_id, action: event.action, at: event.at, detail: event.device_or_run_id })), ...linkActivity.value.map(event => ({ id: `link-${ event.id }`, who: 'Public link', action: event.action, at: event.occurredAt, detail: event.detail }))].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)));

onMounted(async() => {
  const [metadata, history] = await Promise.allSettled([props.dataSource.detail(props.item.id), props.dataSource.history(props.item.id)]);
  if (metadata.status === 'fulfilled') detail.value = metadata.value;
  else error.value = metadata.reason instanceof Error ? metadata.reason.message : String(metadata.reason);
  if (history.status === 'fulfilled') versions.value = history.value;
  else error.value ||= history.reason instanceof Error ? history.reason.message : String(history.reason);
  const [publicLinks, source] = await Promise.allSettled([
    props.dataSource.listPublicLinks?.() || Promise.resolve([]),
    supportsMedia.value ? props.dataSource.mediaUrl(props.item.id, props.item.currentVersionId) : Promise.resolve(''),
  ]);
  if (publicLinks.status === 'fulfilled') links.value = publicLinks.value;
  if (source.status === 'fulfilled') mediaUrl.value = source.value;
  else previewError.value = source.reason instanceof Error ? source.reason.message : String(source.reason);
  if (activeLink.value && props.dataSource.shareActivity) linkActivity.value = await props.dataSource.shareActivity(activeLink.value.id).catch(() => []);
  loading.value = false;
});
async function download() { busy.value = true; try { await props.dataSource.downloadFile(props.item.id, name.value, props.item.currentVersionId) } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { busy.value = false } }
async function restore(id:string) { busy.value = true; try { await props.dataSource.restoreVersion(props.item.id, id); emit('restored') } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { busy.value = false } }
async function revoke() { if (!activeLink.value || !props.dataSource.revokePublicLink) return; busy.value = true; try { await props.dataSource.revokePublicLink(activeLink.value.id); activeLink.value.revokedAt = new Date().toISOString() } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { busy.value = false } }
async function keepOnMac() { if (!props.dataSource.keepOnMac) return; busy.value = true; try { await props.dataSource.keepOnMac(props.item.id) } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) } finally { busy.value = false } }
async function copyLink() { if (!activeLink.value) return; try { await navigator.clipboard.writeText(activeLink.value.url); copied.value = true; setTimeout(() => { copied.value = false }, 1500) } catch { error.value = 'The link could not be copied.' } }
function seek(seconds:number) { const media = video.value || audio.value; if (media) { media.currentTime = seconds; media.play().catch(() => undefined) } mediaTab.value = 'Preview' }
function duration(seconds:number) { const value = Math.max(0, Math.round(Number(seconds) || 0)); return `${ Math.floor(value / 60) }:${ String(value % 60).padStart(2, '0') }` }
function formatBytes(bytes:number) { if (!bytes) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); return `${ Number((bytes / 1024 ** index).toFixed(index ? 1 : 0)) } ${ units[index] }` }
function formatDate(value:string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) }
function shortDate(value:string) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value)) }
function initials(value:string) { return value.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?' }
function activityLabel(action:string) { return ({ preview: 'opened this file', download: 'downloaded this file', viewed: 'opened the public link', downloaded: 'downloaded from the public link', transcript: 'added a transcript', upload: 'uploaded this file', 'version-restore': 'restored a version' } as Record<string, string>)[action] || action.replaceAll('-', ' ') }
function fileIcon(mime:string) { if (mime.startsWith('video/')) return icons.video; if (mime.startsWith('audio/')) return icons.audio; if (mime.startsWith('image/')) return icons.image; if (mime === 'application/pdf') return icons.pdf; return icons.file }
const icons = {
  previous: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v11M7 11l5 5 5-5M4 19h16"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M8.2 10.8l7.6-4M8.2 13.2l7.6 4"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20 15l-4.5-4.5L7 19"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/><path d="M9 17v-5h2a1.5 1.5 0 0 1 0 3H9"/></svg>',
};
</script>

<style scoped>
.file-detail-main{min-width:0;min-height:0;overflow:auto;color:#1a2332;background:#f4f7fb;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;background-image:radial-gradient(900px 500px at 15% -10%,rgba(58,127,160,.10),transparent 60%),radial-gradient(700px 400px at 100% 0%,rgba(58,127,160,.06),transparent 55%)}button{font:inherit;color:inherit;cursor:pointer}.detail-top{display:flex;align-items:center;gap:14px;padding:12px 28px;border-bottom:1px solid rgba(26,35,50,.09);background:rgba(255,255,255,.4);backdrop-filter:blur(10px);position:sticky;top:0;z-index:5}.crumbs{display:flex;gap:6px;color:#8a94a3;font-size:12.5px;white-space:nowrap}.crumbs button{padding:0;border:0;background:none;color:#5b6778}.title{display:flex;align-items:center;gap:10px;min-width:0}.title b{overflow:hidden;font-size:13.5px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}.file-glyph{display:grid;width:26px;height:26px;place-items:center;border-radius:7px;background:rgba(217,64,58,.10);color:#c0392b;font-size:11px;font-weight:700}.file-glyph.small{width:24px;height:24px;background:rgba(58,127,160,.1);color:#2f6a86}.top-actions{display:flex;align-items:center;gap:8px;margin-left:auto}.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:6px 11px;border:1px solid rgba(26,35,50,.14);border-radius:8px;background:#fff;font-size:12.5px;font-weight:500;white-space:nowrap}.btn:hover{border-color:rgba(58,127,160,.32);color:#2f6a86}.btn.primary{border-color:#3a7fa0;background:#3a7fa0;color:#fff}.btn.ghost{border-color:transparent;background:transparent}.btn.ico{width:30px;padding:6px}.btn.sm{padding:3px 8px;font-size:11.5px}.btn.danger{border-color:rgba(217,64,58,.35);color:#b1302b}.btn:disabled{cursor:not-allowed;opacity:.5}.detail-content{padding:20px 28px 60px}.detail-grid{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:18px;align-items:start}.card{border:1px solid rgba(26,35,50,.09);border-radius:12px;background:rgba(255,255,255,.82);box-shadow:0 1px 2px rgba(26,35,50,.04),0 10px 30px -12px rgba(26,35,50,.12);backdrop-filter:blur(12px)}.preview-card{overflow:hidden}.player{position:relative;display:grid;aspect-ratio:16/9;place-items:center;overflow:hidden;background:#0f1721}.player video,.player img,.player iframe{width:100%;height:100%;border:0;object-fit:contain}.player audio{width:min(560px,80%)}.synthetic-frame{position:relative;width:100%;height:100%;background:linear-gradient(135deg,#1b2736,#243447)}.synthetic-frame .window{position:absolute;inset:12% 9%;overflow:hidden;border-radius:8px;background:#f4f7fb;box-shadow:0 20px 60px -20px #000}.synthetic-frame .window>i{display:inline-block;width:8px;height:8px;margin:8px 0 0 5px;border-radius:50%;background:#d0d8e0}.synthetic-frame .sidebar{position:absolute;top:22px;bottom:0;width:22%;background:#edf2f7;border-right:1px solid rgba(26,35,50,.08)}.synthetic-frame .lines{position:absolute;top:42px;right:12%;left:30%;height:55%;background:repeating-linear-gradient(#dbe3ea 0 8px,transparent 8px 20px)}.play{position:absolute;inset:calc(50% - 32px);display:grid;width:64px;height:64px;place-items:center;border-radius:50%;background:rgba(255,255,255,.92);font-size:24px}.preview-bar{background:rgba(255,255,255,.6);display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid rgba(26,35,50,.09)}.seg{display:flex;gap:2px;padding:2px;border:1px solid rgba(26,35,50,.14);border-radius:8px;background:#fff}.seg button{padding:4px 9px;border:0;border-radius:6px;background:transparent;color:#5b6778;font-size:12px}.seg button.on{background:rgba(58,127,160,.10);color:#2f6a86;font-weight:600}.meta{color:#8a94a3;font-size:12px}.pill{display:inline-flex;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}.preview-bar .pill{margin-left:auto}.pill.ok{background:rgba(31,157,85,.12);color:#167a42}.pill.idle{background:rgba(138,148,163,.16);color:#5b6778}.media-pane{min-height:150px;padding:14px 16px 16px}.media-pane h3{display:flex;align-items:center;gap:8px;margin:0 0 10px;font-size:13px}.media-pane h3 small{margin-left:auto;color:#8a94a3;font-weight:400}.muted,.empty,.preview-note{color:#5b6778}.timeline{font-size:12.5px;line-height:1.55;display:grid;grid-template-columns:52px 1fr;gap:4px 12px}.timeline button{padding:2px 0;border:0;background:none;color:#2f6a86;font:11px ui-monospace,monospace;text-align:left}.timeline p{margin:0 0 6px}.chapters{display:grid;gap:6px}.chapters button{display:flex;justify-content:space-between;padding:9px 10px;border:1px solid rgba(26,35,50,.09);border-radius:8px;background:#fff;text-align:left}.chapters span{color:#8a94a3;font:11px ui-monospace,monospace}.side{position:sticky;top:68px}.tabs{display:flex;gap:2px;padding:0 10px;border-bottom:1px solid rgba(26,35,50,.09);overflow:auto}.tabs button{padding:10px;border:0;border-bottom:2px solid transparent;background:transparent;color:#5b6778;font-size:12.5px;white-space:nowrap}.tabs button.on{border-bottom-color:#3a7fa0;color:#2f6a86;font-weight:600}.tag{margin-left:3px;padding:1px 5px;border-radius:5px;background:#eaf0f6;font-size:10px}.pane{padding:14px 16px 16px}.state{color:#5b6778}.kv{font-size:12.5px;display:grid;grid-template-columns:96px 1fr;gap:7px 10px;margin:0}.kv dt{color:#8a94a3}.kv dd{min-width:0;margin:0;overflow-wrap:anywhere}.link{padding:0;border:0;background:none;color:#2f6a86;font-weight:500}.section{margin-top:16px}.section h4{margin:0 0 8px;color:#8a94a3;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase}.provenance{display:flex;gap:10px;padding:10px 12px;border:1px solid rgba(26,35,50,.09);border-radius:9px;background:rgba(26,35,50,.04)}.provenance b,.provenance small{display:block}.provenance small{margin-top:1px;color:#5b6778;font-size:11.5px}.agent,.avatar,.activity-icon{display:grid;width:28px;height:28px;flex:none;place-items:center;border-radius:50%;background:linear-gradient(135deg,#1a2332,#3a7fa0);color:#fff;font-size:9px;font-weight:700}.links{display:grid;gap:4px}.links button{display:flex;align-items:center;gap:9px;padding:6px 8px;border:0;border-radius:8px;background:none;text-align:left}.links button:hover{background:rgba(58,127,160,.06)}.links button>span:nth-child(2){min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.links small{color:#8a94a3}.version{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid rgba(26,35,50,.09)}.version>div{min-width:0;flex:1}.version b,.version small{display:block}.version b{font-weight:500}.version small{color:#8a94a3;font-size:11px}.version-number{padding:2px 6px;border-radius:5px;background:rgba(58,127,160,.10);color:#2f6a86;font:11px ui-monospace,monospace}.version-number.current{background:rgba(31,157,85,.12);color:#167a42}.note{color:#8a94a3;font-size:11.5px}.person{display:flex;align-items:center;gap:9px;padding:6px 0}.person>div{min-width:0;flex:1}.person b,.person small{display:block}.person small{color:#8a94a3;font-size:11px}.person>span:last-child{color:#5b6778;font-size:11.5px}.avatar.alt{background:linear-gradient(135deg,#b7a7e0,#6b4fbf)}.link-actions{display:flex;gap:6px;margin-top:10px}.link-actions .danger{margin-left:auto}.share-people{width:100%;margin-top:16px}.activity-row{display:flex;gap:10px;padding-bottom:14px}.activity-row b{font-weight:600}.activity-row small{display:block;color:#8a94a3;font-size:11px}.activity-icon{width:22px;height:22px}.error{margin-bottom:12px;padding:9px 11px;border-radius:8px;background:rgba(217,64,58,.11);color:#b1302b}@container(max-width:1180px){.detail-grid{grid-template-columns:minmax(0,1fr) 320px}.title b{max-width:280px}}@container(max-width:1120px){.detail-grid{grid-template-columns:1fr}.side{position:static}}@container(max-width:700px){.detail-top{padding:10px 14px;flex-wrap:wrap}.crumbs{display:none}.title{order:2;flex-basis:100%}.top-actions .btn:not(.primary):not(.ico){display:none}.detail-content{padding:12px 12px 40px}.preview-bar{flex-wrap:wrap}.preview-bar .meta{display:none}.kv{grid-template-columns:84px 1fr}}
.file-glyph :deep(svg){width:15px;height:15px}.bi{display:grid;width:13px;height:13px;flex:none}.bi :deep(svg),.unavailable-icon :deep(svg){width:100%;height:100%}.play :deep(svg){width:28px;height:28px}.preview-unavailable{display:grid;justify-items:center;gap:8px;color:#8a94a3;text-align:center}.preview-unavailable b{color:#dbe3ea;font-size:13px}.preview-unavailable small{max-width:320px}.unavailable-icon{width:38px;height:38px}
</style>
