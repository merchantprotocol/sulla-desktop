<template>
  <div class="use-cases" :class="{ 'is-detail': !!pk.detail.value }">
    <aside class="rail">
      <div class="brand"><span class="logo">S</span><div><b>Sulla</b><small>Use Cases</small></div></div>
      <nav class="main-nav">
        <button :class="{ on: view === 'browse' }" @click="showBrowse"><span>⌘</span>Browse <b>{{ pk.packages.value.length }}</b></button>
        <button :class="{ on: view === 'library' }" @click="showLibrary"><span>▥</span>My Library <b>{{ pk.installed.value.length }}</b></button>
        <button :class="{ on: view === 'updates' }" @click="showUpdates"><span>↟</span>Updates <b v-if="updateCount">{{ updateCount }}</b></button>
      </nav>
      <div class="rail-label">Topics</div>
      <nav class="topic-nav">
        <button v-for="topic in topicRows" :key="topic.key" :class="{ on: selectedTopic === topic.key && view === 'browse' }" @click="selectTopic(topic.key)">
          <i :style="{ background: topicColor(topic.key) }" />{{ topic.label }}<b>{{ topic.count }}</b>
        </button>
      </nav>
      <div class="rail-foot"><span class="status-dot" />Use cases install to this Desktop</div>
    </aside>

    <section class="workspace">
      <header class="topbar">
        <b>Use Cases</b>
        <div class="search-wrap">
          <span>⌕</span><input v-model="query" type="search" placeholder="Search use cases — try “estimate” or “inbox”" @focus="searchFocused = true" @blur="onSearchBlur">
          <kbd>⌘K</kbd>
          <div v-if="showSuggestions" class="suggestions">
            <button v-for="item in suggestions" :key="item.id" @mousedown.prevent="openPackage(item)"><span>{{ item.icon }}</span><div><b>{{ item.title }}</b><small>{{ item.line }}</small></div><em>{{ topicLabel(item.topic) }}</em></button>
          </div>
        </div>
        <button class="btn" @click="publishUseCase">↟&nbsp; Publish a use case</button>
      </header>

      <main class="content">
        <div v-if="download" class="banner"><span class="spin" /><div><b>Getting {{ download.name }}</b><small>Downloading and installing into Sulla Desktop…</small></div><div class="progress"><i /></div></div>
        <div v-if="feedback" class="banner" :class="feedback.kind"><span>{{ feedback.kind === 'error' ? '!' : '✓' }}</span><div><b>{{ feedback.message }}</b></div><button @click="feedback = null">×</button></div>

        <PackageDetail v-if="pk.detail.value" :detail="pk.detail.value" :installed="pk.installedSlugs.value.has(pk.detail.value.row.slug)" :busy="pk.busySlug.value === pk.detail.value.row.slug" @close="pk.clearDetail()" @get="onGet(pk.detail.value.row)" @open-library="openInstalled(pk.detail.value.row.slug)" />
        <div v-else-if="pk.detailLoading.value" class="empty">Loading use case…</div>
        <div v-else-if="pk.detailError.value" class="empty"><b>Couldn't open that use case</b><p>{{ pk.detailError.value }}</p><button class="btn" @click="pk.clearDetail()">Back</button></div>

        <template v-else-if="view === 'browse'">
          <div class="heading"><h1>{{ selectedTopic ? topicLabel(selectedTopic) : 'Use Cases' }}</h1><span>{{ browseSubtitle }}</span></div>
          <div v-if="pk.error.value" class="empty"><b>Couldn't load use cases</b><p>{{ pk.error.value }}</p><button class="btn" @click="pk.load()">Try again</button></div>
          <div v-else-if="pk.isLoading.value" class="empty">Loading use cases…</div>
          <div v-else-if="filtered.length === 0" class="empty"><b>No use cases found</b><p>Try different words or another topic.</p></div>
          <div v-else class="table-card">
            <table><thead><tr><th>Use case</th><th>Includes</th><th>By</th><th /></tr></thead>
              <tbody><template v-for="group in browseGroups" :key="group.label">
                <tr class="section"><td colspan="4">{{ group.label }} <span>{{ group.items.length }}</span></td></tr>
                <tr v-for="item in group.items" :key="item.id" class="item" @click="openPackage(item)">
                  <td><div class="name"><span class="glyph">{{ item.icon }}</span><div><b>{{ item.title }}</b><small>{{ item.line }}</small></div></div></td>
                  <td><span>{{ includesLine(item) }}</span><small v-if="item.app === 'dashboard'" class="dash">▣ Includes a dashboard</small></td>
                  <td>{{ publisher(item) }}</td>
                  <td class="action"><span v-if="installed(item.slug)?.active" class="state active"><i />Active</span><span v-else-if="installed(item.slug)" class="state"><i />In your library</span><button v-else class="btn sm" :disabled="!!pk.busySlug.value" @click.stop="onGet(item)">⇩&nbsp; Get</button></td>
                </tr>
              </template></tbody>
            </table>
          </div>
        </template>

        <template v-else>
          <div class="heading"><h1>{{ view === 'updates' ? 'Updates' : 'My Library' }}</h1><span>{{ librarySubtitle }}</span><button v-if="updateCount" class="btn right" @click="updateAll">↟ Update all ({{ updateCount }})</button></div>
          <div v-if="libraryRows.length === 0" class="empty"><b>{{ view === 'updates' ? 'Everything is up to date' : 'Your library is empty' }}</b><p v-if="view !== 'updates'">Browse Use Cases and pull one down.</p></div>
          <div v-else class="panes">
            <div class="table-card"><table><thead><tr><th>Use case</th><th>Version</th><th>Added</th><th>Status</th></tr></thead><tbody>
              <tr class="section"><td colspan="4">Active <span>{{ activeRows.length }}</span></td></tr>
              <tr v-for="item in activeRows" :key="item.slug" class="item" :class="{ selected: selectedSlug === item.slug }" @click="selectedSlug = item.slug"><td><div class="name"><span class="glyph">{{ item.icon || '◆' }}</span><div><b>{{ item.title }}</b><small>{{ item.name }}</small></div></div></td><td>v{{ item.version }}</td><td>{{ dateLabel(item.installedAt) }}</td><td><span class="state active"><i />Active</span></td></tr>
              <tr class="section"><td colspan="4">Off <span>{{ offRows.length }}</span></td></tr>
              <tr v-for="item in offRows" :key="item.slug" class="item" :class="{ selected: selectedSlug === item.slug }" @click="selectedSlug = item.slug"><td><div class="name"><span class="glyph">{{ item.icon || '◆' }}</span><div><b>{{ item.title }}</b><small>{{ item.name }}</small></div></div></td><td>v{{ item.version }}</td><td>{{ dateLabel(item.installedAt) }}</td><td><span class="state"><i />Off</span></td></tr>
            </tbody></table></div>
            <aside v-if="selectedInstalled" class="detail-panel">
              <div class="panel-head"><span class="glyph lg">{{ selectedInstalled.icon || '◆' }}</span><div><h2>{{ selectedInstalled.title }}</h2><small>{{ selectedInstalled.name }} · v{{ selectedInstalled.version }}</small></div></div>
              <div class="status-box" :class="{ on: selectedInstalled.active }"><b>{{ selectedInstalled.active ? 'Active' : 'Off' }}</b><span>{{ selectedInstalled.active ? 'Agents, workflows, and recipes are available.' : 'Installed, but nothing runs until you make it active.' }}</span></div>
              <div class="panel-actions"><button v-if="selectedInstalled.active" class="btn" :disabled="!!pk.busySlug.value" @click="deactivate(selectedInstalled)">Ⅱ Deactivate</button><button v-else class="btn primary" :disabled="!!pk.busySlug.value" @click="openActivate(selectedInstalled)">▶ Make active</button></div>
              <div class="parts"><b>What's included</b><div v-for="g in installedGroups" :key="g.kind"><small>{{ g.label }}</small><p v-for="item in g.items" :key="item.slug">{{ item.slug }}</p></div></div>
              <div class="panel-bottom"><button class="btn danger" @click="openUninstall(selectedInstalled)">⌫ Uninstall</button></div>
            </aside>
          </div>
        </template>
      </main>
    </section>

    <div v-if="activateTarget" class="scrim" @click.self="closeActivate"><div class="dialog">
      <header><div><small>Make active · Step {{ activateStep }} of 3</small><h2>{{ activateTitle }}</h2></div><button @click="closeActivate">×</button></header>
      <div class="steps"><i :class="{ done: activateStep > 1, on: activateStep === 1 }">1</i><span /><i :class="{ done: activateStep > 2, on: activateStep === 2 }">2</i><span /><i :class="{ on: activateStep === 3 }">3</i></div>
      <section v-if="activateStep === 1" class="dialog-body"><p>Connections are kept in the Vault. Add or review credentials there, then come back to continue.</p><div v-if="integrationItems.length" class="needs"><div v-for="item in integrationItems" :key="item.slug"><span class="glyph">⌁</span><div><b>{{ item.slug }}</b><small>Credential status is checked in the Vault.</small></div><button class="btn sm" @click="openVault(item.slug)">Open Vault</button></div></div><div v-else class="honest">This use case doesn't declare any integrations.</div></section>
      <section v-else-if="activateStep === 2" class="dialog-body"><p>Allow this use case to do the following on this Desktop:</p><ul class="allow"><li v-for="line in permissionLines" :key="line">✓ {{ line }}</li></ul><label v-if="needsNetworkConsent" class="consent"><input v-model="networkConsent" type="checkbox"> I trust this network and allow this use case to scan it.</label></section>
      <section v-else class="dialog-body"><p>{{ starting ? 'Starting the real services declared by this use case…' : startError || 'Ready to start.' }}</p><div class="start-list"><div v-for="(line, i) in startLines" :key="line"><span :class="{ spin: starting && i === startIndex, check: !starting || i < startIndex }" />{{ line }}</div></div></section>
      <footer><button class="btn" @click="activateStep === 1 ? closeActivate() : activateStep--">{{ activateStep === 1 ? 'Cancel' : 'Back' }}</button><button v-if="activateStep < 3" class="btn primary" :disabled="activateStep === 2 && needsNetworkConsent && !networkConsent" @click="activateStep++">Continue</button><button v-else class="btn primary" :disabled="starting" @click="startPackage">{{ starting ? 'Starting…' : 'Start' }}</button></footer>
    </div></div>

    <div v-if="uninstallTarget" class="scrim" @click.self="uninstallTarget = null"><div class="dialog narrow"><header><div><small>Uninstall use case</small><h2>Uninstall {{ uninstallTarget.title }}?</h2></div><button @click="uninstallTarget = null">×</button></header><section class="dialog-body"><p>Sulla removes the package and its unchanged marketplace items.</p><label class="choice"><input v-model="removeData" :value="false" type="radio"> <span><b>Keep data</b><small>Stops containers and keeps named Docker volumes.</small></span></label><label class="choice danger-choice"><input v-model="removeData" :value="true" type="radio"> <span><b>Also remove data</b><small>Deletes the use case's named Docker volumes. This can't be undone.</small></span></label></section><footer><button class="btn" @click="uninstallTarget = null">Cancel</button><button class="btn danger" :disabled="!!pk.busySlug.value" @click="confirmUninstall">Uninstall</button></footer></div></div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import PackageDetail from './PackageDetail.vue';
import { loadPackageTopics, packageTopicLabel, usePackageTopics } from '@pkg/composables/packageTopics';
import { packageMatches, usePackages, type InstalledPackage, type PackageRow } from '@pkg/composables/usePackages';

const emit = defineEmits<{ (e: 'installed'): void; (e: 'feedback', kind: 'success' | 'error' | 'info', message: string): void }>();
const router = useRouter();
const pk = usePackages();
const topics = usePackageTopics();
const view = ref<'browse' | 'library' | 'updates'>('browse');
const query = ref('');
const searchFocused = ref(false);
const selectedTopic = ref('');
const selectedSlug = ref<string | null>(null);
const download = ref<{ name: string } | null>(null);
const feedback = ref<{ kind: 'success' | 'error'; message: string } | null>(null);
const activateTarget = ref<InstalledPackage | null>(null);
const activateStep = ref(1);
const networkConsent = ref(false);
const starting = ref(false);
const startIndex = ref(0);
const startError = ref('');
const uninstallTarget = ref<InstalledPackage | null>(null);
const removeData = ref(false);

const filtered = computed(() => pk.packages.value.filter(p => packageMatches(p, query.value) && (!selectedTopic.value || p.topic === selectedTopic.value)));
const suggestions = computed(() => pk.packages.value.filter(p => packageMatches(p, query.value)).slice(0, 5));
const showSuggestions = computed(() => searchFocused.value && query.value.trim().length > 0 && suggestions.value.length > 0);
const topicRows = computed(() => topics.value.map(t => ({ ...t, count: pk.packages.value.filter(p => p.topic === t.key).length })).filter(t => t.count));
const browseGroups = computed(() => {
  if (query.value || selectedTopic.value) return [{ label: selectedTopic.value ? topicLabel(selectedTopic.value) : 'Search results', items: filtered.value }];
  const featured = filtered.value.slice(0, 4);
  const used = new Set(featured.map(p => p.id));
  const groups = [{ label: 'Featured', items: featured.length ? featured : filtered.value.slice(0, 4) }];
  groups[0].items.forEach(p => used.add(p.id));
  for (const topic of topicRows.value) { const items = filtered.value.filter(p => p.topic === topic.key && !used.has(p.id)); if (items.length) groups.push({ label: `More in ${topic.label}`, items }); }
  const rest = filtered.value.filter(p => !used.has(p.id) && !groups.some(g => g.items.includes(p))); if (rest.length) groups.push({ label: 'More use cases', items: rest });
  return groups;
});
const selectedInstalled = computed(() => pk.installed.value.find(p => p.slug === selectedSlug.value) ?? pk.installed.value[0] ?? null);
const activeRows = computed(() => libraryRows.value.filter(p => p.active));
const offRows = computed(() => libraryRows.value.filter(p => !p.active));
const updateCount = computed(() => pk.installed.value.filter(i => { const row = pk.packages.value.find(p => p.slug === i.slug); return !!row && row.version !== i.version; }).length);
const libraryRows = computed(() => view.value === 'updates' ? pk.installed.value.filter(i => { const row = pk.packages.value.find(p => p.slug === i.slug); return !!row && row.version !== i.version; }) : pk.installed.value);
const browseSubtitle = computed(() => selectedTopic.value ? `${filtered.value.length} ready-made job${filtered.value.length === 1 ? '' : 's'}` : 'Ready-made jobs for your agents. Pull one down, then switch it on.');
const librarySubtitle = computed(() => `${libraryRows.value.length} use case${libraryRows.value.length === 1 ? '' : 's'} installed on this Desktop.`);
const installedGroups = computed(() => groupItems(selectedInstalled.value?.items ?? []));
const integrationItems = computed(() => activateTarget.value?.items.filter(i => i.kind === 'integration') ?? []);
const needsNetworkConsent = computed(() => {
  const m: any = activateTarget.value?.manifest ?? {};
  return m.permissions?.network_scan === true || m.permissions?.networkScan === true || m.network_scan === true;
});
const permissionLines = computed(() => {
  const p = activateTarget.value; if (!p) return [];
  const out: string[] = [];
  const counts = groupItems(p.items); for (const g of counts) out.push(`${g.items.length} ${g.label.toLowerCase()}${g.items.length === 1 ? '' : 's'} on this Desktop`);
  if (p.items.some(i => i.kind === 'recipe')) out.push('Start and stop Docker containers from Postgres recipe definitions');
  if (needsNetworkConsent.value) out.push('Scan the trusted local network');
  return out;
});
const startLines = computed(() => { const lines = ['Enable agents, skills, workflows, and functions']; if (activateTarget.value?.items.some(i => i.kind === 'recipe')) lines.push('Start recipe containers'); lines.push('Refresh Sulla runtime catalogs'); return lines; });
const activateTitle = computed(() => ['Connect what it needs', 'Review what it can do', `Start ${activateTarget.value?.title ?? 'use case'}`][activateStep.value - 1]);

function topicLabel(key: string) { return packageTopicLabel(key) || key || 'Other'; }
function topicColor(key: string) { const colors = ['#be8a2c', '#5794ad', '#8564c7', '#bf5956', '#48a275']; let n = 0; for (const c of key) n += c.charCodeAt(0); return colors[n % colors.length]; }
function installed(slug: string) { return pk.installed.value.find(p => p.slug === slug); }
function publisher(item: PackageRow) { return item.publisher; }
function includesLine(item: PackageRow) { const d = item.contents; if (!d.length) return 'Open to see what’s included'; return groupItems(d).map(g => `${g.items.length} ${g.label.toLowerCase()}${g.items.length === 1 ? '' : 's'}`).join(' · '); }
function groupItems(items: { kind: string; slug: string }[]) { const labels: Record<string,string> = { agent:'Agent', skill:'Skill', routine:'Workflow', function:'Function', integration:'Integration', recipe:'Recipe' }; return Object.entries(labels).map(([kind,label]) => ({ kind, label, items: items.filter(i => i.kind === kind) })).filter(g => g.items.length); }
function dateLabel(value: string) { const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function onSearchBlur() { setTimeout(() => { searchFocused.value = false }, 120); }
function showBrowse() { view.value = 'browse'; selectedTopic.value = ''; pk.clearDetail(); }
function showLibrary() { view.value = 'library'; pk.clearDetail(); if (!selectedSlug.value) selectedSlug.value = pk.installed.value[0]?.slug ?? null; }
function showUpdates() { view.value = 'updates'; pk.clearDetail(); }
function selectTopic(key: string) { view.value = 'browse'; selectedTopic.value = key; pk.clearDetail(); }
function openPackage(item: PackageRow) { searchFocused.value = false; pk.loadDetail(item.id).catch(() => undefined); }
function openInstalled(slug: string) { pk.clearDetail(); view.value = 'library'; selectedSlug.value = slug; }
function publishUseCase() { router.push('/Routines').catch(() => undefined); emit('feedback', 'info', 'Publish a package from Sulla Studio.'); }
async function onGet(row: PackageRow) { download.value = { name: row.title }; const res = await pk.install(row); download.value = null; if (res.ok) { feedback.value = { kind:'success', message:`${row.title} is in My Library.` }; emit('installed'); openInstalled(row.slug); } else feedback.value = { kind:'error', message:res.error || `Couldn't get ${row.title}.` }; }
function openActivate(item: InstalledPackage) { activateTarget.value = item; activateStep.value = 1; networkConsent.value = false; startError.value = ''; startIndex.value = 0; }
function closeActivate() { if (!starting.value) activateTarget.value = null; }
function openVault(slug: string) { router.push(`/Integrations/${encodeURIComponent(slug)}`).catch(() => undefined); }
async function startPackage() { if (!activateTarget.value) return; starting.value = true; startError.value = ''; startIndex.value = 0; const timer = window.setInterval(() => { if (startIndex.value < startLines.value.length - 1) startIndex.value++ }, 800); const target = activateTarget.value; const res = await pk.setActive(target.slug, true); window.clearInterval(timer); starting.value = false; if (res.ok) { activateTarget.value = null; selectedSlug.value = target.slug; feedback.value = { kind:'success', message:`${target.title} is active.` }; } else startError.value = res.error || `Couldn't start ${target.title}.`; }
async function deactivate(item: InstalledPackage) { const res = await pk.setActive(item.slug, false); feedback.value = res.ok ? { kind:'success', message:`${item.title} is off.` } : { kind:'error', message:res.error || `Couldn't deactivate ${item.title}.` }; }
function openUninstall(item: InstalledPackage) { uninstallTarget.value = item; removeData.value = false; }
async function confirmUninstall() { if (!uninstallTarget.value) return; const target = uninstallTarget.value; const res = await pk.uninstall(target.slug, removeData.value); if (res.ok) { uninstallTarget.value = null; selectedSlug.value = null; feedback.value = { kind:'success', message:`${target.title} uninstalled${removeData.value ? ' and data removed' : '; data kept'}.` }; emit('installed'); } else feedback.value = { kind:'error', message:res.error || `Couldn't uninstall ${target.title}.` }; }
async function updateAll() { for (const item of libraryRows.value) { const row = pk.packages.value.find(p => p.slug === item.slug); if (row) await onGet(row); } }

onMounted(async() => { await Promise.all([pk.load(), pk.loadInstalled(), loadPackageTopics()]); if (pk.installed.value.length) selectedSlug.value = pk.installed.value[0].slug; });
</script>

<style scoped>
.use-cases{--uc-bg:var(--nx-paper,var(--bg-page,#f3f6fa));--uc-card:var(--nx-surface,var(--bg-surface,#fff));--uc-text:var(--nx-read-1,var(--text-primary,#1d2a3b));--uc-muted:var(--nx-read-3,var(--text-muted,#637188));--uc-dim:var(--nx-read-4,var(--text-dim,#8a96a8));--uc-line:var(--nx-hair,var(--border-default,#dbe1e8));--uc-accent:var(--nx-accent,var(--accent-primary,#3b7f9c));display:grid;grid-template-columns:210px minmax(0,1fr);min-height:720px;background:var(--uc-bg);color:var(--uc-text);font:13px var(--font-body,system-ui,sans-serif);border-radius:10px;overflow:hidden}
button,input{font:inherit}.rail{padding:18px 14px;display:flex;flex-direction:column;border-right:1px solid var(--uc-line);background:color-mix(in srgb,var(--uc-card) 55%,transparent)}.brand{display:flex;align-items:center;gap:10px;padding:6px 8px 22px}.brand .logo{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,#4f97b4,#18384a);font-weight:700}.brand b,.brand small{display:block}.brand small{font-size:10px;color:var(--uc-dim);margin-top:2px}.main-nav,.topic-nav{display:grid;gap:3px}.main-nav button,.topic-nav button{border:0;background:transparent;color:var(--uc-muted);display:grid;grid-template-columns:18px 1fr auto;align-items:center;text-align:left;padding:9px 10px;border-radius:9px;cursor:pointer}.main-nav button.on,.topic-nav button.on{background:color-mix(in srgb,var(--uc-accent) 13%,transparent);color:var(--uc-accent);font-weight:600}.main-nav b,.topic-nav b{font-size:11px;background:color-mix(in srgb,var(--uc-text) 6%,transparent);padding:2px 6px;border-radius:9px}.rail-label{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--uc-dim);font-weight:700;margin:20px 10px 7px}.topic-nav i{width:7px;height:7px;border-radius:2px;margin-left:3px}.rail-foot{margin-top:auto;border:1px solid var(--uc-line);border-radius:9px;padding:11px;color:var(--uc-muted);font-size:11px}.status-dot,.state i{display:inline-block;width:8px;height:8px;border-radius:50%;background:#2eaf66;margin-right:6px;box-shadow:0 0 0 3px color-mix(in srgb,#2eaf66 12%,transparent)}
.workspace{min-width:0}.topbar{height:58px;padding:0 28px;display:grid;grid-template-columns:auto minmax(280px,560px) 1fr;align-items:center;gap:16px;border-bottom:1px solid var(--uc-line);background:color-mix(in srgb,var(--uc-card) 65%,transparent)}.topbar>b{font-size:13px}.search-wrap{position:relative;display:flex;align-items:center;gap:8px;height:34px;padding:0 10px;border:1px solid var(--uc-line);background:var(--uc-card);border-radius:10px}.search-wrap input{border:0;outline:0;background:transparent;color:var(--uc-text);flex:1;min-width:0}.search-wrap kbd{font-size:10px;color:var(--uc-dim);border:1px solid var(--uc-line);padding:2px 5px;border-radius:5px}.suggestions{position:absolute;top:40px;left:0;right:0;z-index:10;background:var(--uc-card);border:1px solid var(--uc-line);border-radius:10px;box-shadow:0 12px 30px #0003;padding:5px}.suggestions button{width:100%;border:0;background:transparent;color:var(--uc-text);display:grid;grid-template-columns:28px 1fr auto;gap:8px;text-align:left;padding:8px;border-radius:7px}.suggestions button:hover{background:color-mix(in srgb,var(--uc-accent) 8%,transparent)}.suggestions b,.suggestions small{display:block}.suggestions small,.suggestions em{font-size:10px;color:var(--uc-dim);font-style:normal}.topbar>.btn{justify-self:end}.content{padding:22px 28px 56px}.heading{display:flex;align-items:baseline;gap:10px;margin-bottom:16px}.heading h1{font-size:20px;margin:0}.heading>span{color:var(--uc-dim)}.heading .right{margin-left:auto}
.btn{border:1px solid var(--uc-line);background:var(--uc-card);color:var(--uc-text);border-radius:8px;padding:7px 12px;cursor:pointer}.btn:hover{border-color:var(--uc-accent)}.btn.sm{padding:4px 10px;font-size:12px}.btn.primary{background:var(--uc-accent);border-color:var(--uc-accent);color:#fff}.btn.danger{color:#d45454;border-color:color-mix(in srgb,#d45454 35%,var(--uc-line))}.btn:disabled{opacity:.55;cursor:progress}.table-card,.detail-panel{background:var(--uc-card);border:1px solid var(--uc-line);border-radius:11px;overflow:hidden;box-shadow:0 8px 24px #0000000b}table{width:100%;border-collapse:collapse}th{text-align:left;padding:9px 14px;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--uc-dim);border-bottom:1px solid var(--uc-line)}td{padding:10px 14px;border-bottom:1px solid var(--uc-line);color:var(--uc-muted)}tr.item{cursor:pointer}tr.item:hover td,tr.item.selected td{background:color-mix(in srgb,var(--uc-accent) 7%,transparent)}tr.section td{padding:12px 14px 7px;font-size:10px;text-transform:uppercase;letter-spacing:.07em;font-weight:700;color:var(--uc-dim)}tr.section span{float:right}.name{display:flex;align-items:center;gap:10px;color:var(--uc-text)}.name b,.name small{display:block}.name b{font-weight:500}.name small{font-size:11px;color:var(--uc-dim);max-width:500px}.glyph{width:30px;height:30px;border-radius:7px;background:color-mix(in srgb,var(--uc-accent) 12%,transparent);display:grid;place-items:center;flex:none}.glyph.lg{width:48px;height:48px;border-radius:12px;font-size:20px}.dash{display:block;color:var(--uc-accent);font-size:11px;margin-top:3px}.action{text-align:right}.state{white-space:nowrap;font-size:12px}.state i{background:#9aa8b8;box-shadow:none}.state.active{color:#2eaf66}.state.active i{background:#2eaf66}.empty{text-align:center;padding:70px 20px;color:var(--uc-muted)}.empty b{display:block;color:var(--uc-text);font-size:15px}.banner{display:flex;align-items:center;gap:10px;padding:10px 12px;margin-bottom:14px;border:1px solid color-mix(in srgb,var(--uc-accent) 35%,var(--uc-line));border-radius:9px;background:color-mix(in srgb,var(--uc-accent) 8%,var(--uc-card))}.banner>div{display:grid}.banner small{color:var(--uc-muted)}.banner button{margin-left:auto;border:0;background:transparent;color:var(--uc-muted)}.banner.error{border-color:#d4545460}.progress{margin-left:auto;width:140px;height:5px;background:var(--uc-line);overflow:hidden;border-radius:3px}.progress i{display:block;width:40%;height:100%;background:var(--uc-accent);animation:progress 1.1s infinite}.spin{width:16px;height:16px;border:2px solid var(--uc-line);border-top-color:var(--uc-accent);border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@keyframes progress{from{transform:translateX(-100%)}to{transform:translateX(350%)}}
.panes{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:16px}.detail-panel{align-self:start}.panel-head{display:flex;gap:12px;align-items:center;padding:16px;border-bottom:1px solid var(--uc-line)}.panel-head h2{margin:0;font-size:15px}.panel-head small{color:var(--uc-dim)}.status-box{margin:14px;padding:12px;border:1px solid var(--uc-line);border-radius:9px}.status-box.on{border-color:#2eaf6650;background:#2eaf660d}.status-box b,.status-box span{display:block}.status-box span{color:var(--uc-muted);font-size:11px;margin-top:3px}.panel-actions{padding:0 14px 14px}.parts{padding:14px;border-top:1px solid var(--uc-line)}.parts>b{font-size:12px}.parts>div>small{display:block;margin-top:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--uc-dim);font-size:9px}.parts p{margin:4px 0;color:var(--uc-muted)}.panel-bottom{padding:14px;border-top:1px solid var(--uc-line)}
.scrim{position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:#10182870}.dialog{width:min(680px,92vw);max-height:88vh;overflow:auto;border:1px solid var(--uc-line);border-radius:12px;background:var(--uc-card);box-shadow:0 22px 70px #0006}.dialog.narrow{width:min(500px,92vw)}.dialog header,.dialog footer{display:flex;align-items:center;padding:15px 18px;border-bottom:1px solid var(--uc-line)}.dialog header h2{margin:2px 0 0;font-size:17px}.dialog header small{color:var(--uc-dim)}.dialog header>button{margin-left:auto;border:0;background:none;color:var(--uc-muted);font-size:20px}.dialog footer{justify-content:flex-end;gap:8px;border-bottom:0;border-top:1px solid var(--uc-line)}.dialog-body{padding:18px;color:var(--uc-muted)}.steps{display:flex;align-items:center;justify-content:center;padding:14px}.steps i{width:25px;height:25px;border:1px solid var(--uc-line);border-radius:50%;display:grid;place-items:center;font-style:normal}.steps i.on,.steps i.done{background:var(--uc-accent);border-color:var(--uc-accent);color:#fff}.steps span{width:90px;height:1px;background:var(--uc-line)}.needs>div{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--uc-line)}.needs>div>div{flex:1}.needs b,.needs small{display:block}.needs small{font-size:11px}.honest{padding:12px;border:1px solid var(--uc-line);border-radius:8px}.allow{list-style:none;padding:0}.allow li{padding:8px 0;border-top:1px solid var(--uc-line);color:var(--uc-text)}.consent,.choice{display:flex;gap:10px;padding:12px;border:1px solid var(--uc-line);border-radius:9px;color:var(--uc-text)}.choice+ .choice{margin-top:9px}.choice b,.choice small{display:block}.choice small{color:var(--uc-muted);margin-top:3px}.danger-choice{border-color:#d4545450}.start-list>div{display:flex;align-items:center;gap:9px;padding:8px 0}.start-list span{width:16px;height:16px;border:1px solid var(--uc-line);border-radius:50%}.start-list span.check{background:#2eaf66;border-color:#2eaf66}.start-list span.check:after{content:'✓';color:#fff;font-size:10px;display:grid;place-items:center}
@media(max-width:900px){.use-cases{grid-template-columns:170px 1fr}.topbar{grid-template-columns:auto 1fr}.topbar>.btn{display:none}.panes{grid-template-columns:1fr}.detail-panel{position:static}th:nth-child(2),td:nth-child(2){display:none}}
</style>
