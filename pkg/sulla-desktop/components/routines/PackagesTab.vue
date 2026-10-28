<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="use-cases" :class="{ 'showing-detail': Boolean(pk.detail.value) && isUseCaseView }">
    <aside class="rail">
      <div class="brand"><span class="brand-mark">S</span><div><b>Sulla</b><small>Studio</small></div></div>
      <nav class="nav-list">
        <button :class="{ selected: view === 'browse' }" @click="showBrowse"><UseCaseIcon name="grid" /><span>Browse</span><b>{{ pk.packages.value.length }}</b></button>
        <button :class="{ selected: view === 'library' }" @click="showLibrary"><UseCaseIcon name="library" /><span>My Library</span><b>{{ pk.installed.value.length }}</b></button>
        <button :class="{ selected: view === 'updates' }" @click="showUpdates"><UseCaseIcon name="up" /><span>Updates</span><b v-if="updateCount" class="warning">{{ updateCount }}</b></button>
      </nav>
      <hr class="rail-separator">
      <nav class="nav-list">
        <button :class="{ selected: view === 'workflows' }" @click="showSection('workflows')"><UseCaseIcon name="workflow" /><span>Workflows</span></button>
        <button :class="{ selected: view === 'skills' }" @click="showSection('skills')"><UseCaseIcon name="skill" /><span>Saved Skills</span></button>
        <button :class="{ selected: view === 'agents' }" @click="showSection('agents')"><UseCaseIcon name="agent" /><span>Custom Agents</span></button>
        <button :class="{ selected: view === 'recipes' }" @click="showSection('recipes')"><UseCaseIcon name="recipe" /><span>Recipes</span></button>
      </nav>
      <hr class="rail-separator">
      <nav class="nav-list">
        <button :class="{ selected: view === 'live' }" @click="showSection('live')"><UseCaseIcon name="pulse" /><span>Live Agents</span></button>
        <button :class="{ selected: view === 'usage' }" @click="showSection('usage')"><UseCaseIcon name="usage" /><span>Token Usage</span></button>
      </nav>
      <div class="rail-spacer" />
    </aside>

    <section v-if="!isUseCaseView" class="workspace section-host">
      <slot name="section" :section="view" />
    </section>

    <section v-else class="workspace">
      <header class="topbar">
        <div class="crumbs">
          <template v-if="pk.detail.value"><button @click="showBrowse">Use Cases</button><span>›</span><button v-if="pk.detail.value.row.topic" @click="selectTopic(pk.detail.value.row.topic)">{{ topicLabel(pk.detail.value.row.topic) }}</button><span>›</span><b>{{ pk.detail.value.row.title }}</b></template>
          <b v-else>{{ view === 'browse' ? 'Use Cases' : view === 'library' ? 'My Library' : 'Updates' }}</b>
        </div>
        <div class="search-wrap">
          <UseCaseIcon name="search" /><input v-model="query" type="search" placeholder="Search use cases — try “estimate” or “inbox”" @focus="searchFocused = true" @blur="onSearchBlur"><kbd>⌘K</kbd>
          <div v-if="showSuggestions" class="suggestions">
            <button v-for="item in suggestions" :key="item.id" @mousedown.prevent="openPackage(item)">
              <span class="feature-icon" :class="topicTone(item.topic)"><UseCaseIcon :name="packageIcon(item)" /></span>
              <span><b>{{ item.title }}</b><small>{{ item.line }}</small></span><em>{{ topicLabel(item.topic) }}</em>
            </button>
          </div>
        </div>
        <button class="button publish" @click="publishUseCase"><UseCaseIcon name="up" /> Publish a use case</button>
      </header>

      <main class="content">
        <div v-if="download" class="banner">
          <span class="banner-icon"><UseCaseIcon name="download" /></span><div><b>Pulling down {{ download.name }}…</b><small>Downloading and installing into Sulla Desktop. You can keep browsing.</small><div class="indeterminate"><i /></div></div>
        </div>
        <div v-if="feedback" class="banner" :class="feedback.kind"><span class="banner-icon"><UseCaseIcon :name="feedback.kind === 'error' ? 'info' : 'check'" /></span><div><b>{{ feedback.message }}</b></div><button class="icon-button" @click="feedback = null"><UseCaseIcon name="close" /></button></div>

        <PackageDetail v-if="pk.detail.value" :detail="pk.detail.value" :installed="pk.installedSlugs.value.has(pk.detail.value.row.slug)" :busy="pk.busySlug.value === pk.detail.value.row.slug" @close="pk.clearDetail()" @get="onGet(pk.detail.value.row)" @open-library="openInstalled(pk.detail.value.row.slug)" />
        <div v-else-if="pk.detailLoading.value" class="empty">Loading use case…</div>
        <div v-else-if="pk.detailError.value" class="empty"><b>Couldn't open that use case</b><p>{{ pk.detailError.value }}</p><button class="button" @click="pk.clearDetail()">Back</button></div>

        <template v-else-if="view === 'browse'">
          <div class="toolbar"><h1>{{ selectedTopic ? topicLabel(selectedTopic) : 'Use Cases' }}</h1><span>{{ browseSubtitle }}</span></div>
          <div v-if="pk.error.value" class="empty"><b>Couldn't load use cases</b><p>{{ pk.error.value }}</p><button class="button" @click="pk.load()">Try again</button></div>
          <div v-else-if="pk.isLoading.value" class="empty">Loading use cases…</div>
          <div v-else-if="filtered.length === 0" class="empty"><b>No use cases found</b><p>Try different words or another topic.</p></div>
          <div v-else class="card table-card"><table><thead><tr><th>Use case</th><th>Includes</th><th>By</th><th /></tr></thead><tbody>
            <template v-for="group in browseGroups" :key="group.label">
              <tr class="section-row"><td colspan="4">{{ group.label }} <span>{{ group.items.length }}</span></td></tr>
              <tr v-for="item in group.items" :key="item.id" class="item-row" @click="openPackage(item)">
                <td><div class="name-cell"><span class="feature-icon" :class="topicTone(item.topic)"><UseCaseIcon :name="packageIcon(item)" /></span><div><b>{{ item.title }}</b><small>{{ item.line }}</small></div></div></td>
                <td><span>{{ includesLine(item) }}</span><small v-if="item.dashboardPort" class="dashboard"><UseCaseIcon name="screen" /> Includes a dashboard</small></td>
                <td class="publisher">{{ item.publisher }}</td>
                <td class="row-action"><span v-if="installed(item.slug)?.active" class="state active"><i />Active</span><span v-else-if="installed(item.slug)" class="state"><i />In your library</span><button v-else class="button small" :disabled="Boolean(pk.busySlug.value)" @click.stop="onGet(item)"><UseCaseIcon name="download" /> Get</button></td>
              </tr>
            </template>
          </tbody></table></div>
        </template>

        <template v-else-if="view === 'updates'">
          <div class="toolbar"><h1>Updates</h1><span>Use cases with a newer version in Use Cases.</span><div class="toolbar-actions"><button v-if="updateCount" class="button primary" :disabled="Boolean(pk.busySlug.value)" @click="updateAll"><UseCaseIcon name="up" /> Update all ({{ updateCount }})</button></div></div>
          <div v-if="libraryRows.length === 0" class="empty card"><b>Everything is up to date</b><p>Updating keeps your settings and data.</p></div>
          <div v-else class="card table-card"><table><thead><tr><th>Use case</th><th>Installed</th><th>Available</th><th>Updated</th><th /></tr></thead><tbody>
            <tr v-for="item in libraryRows" :key="item.slug" class="item-row" @click="openInstalled(item.slug)"><td><div class="name-cell"><span class="feature-icon" :class="topicTone(marketplaceRow(item.slug)?.topic || '')"><UseCaseIcon :name="marketplaceRow(item.slug) ? packageIcon(marketplaceRow(item.slug)!) : 'box'" /></span><span><b>{{ item.title }}</b><small>{{ marketplaceRow(item.slug)?.publisher || 'Sulla' }}</small></span></div></td><td><code>{{ item.version }}</code></td><td><code class="available">{{ marketplaceRow(item.slug)?.version }}</code></td><td>{{ dateLabel(marketplaceRow(item.slug)?.updatedAt || '') }}</td><td class="row-action"><button class="button small" :disabled="Boolean(pk.busySlug.value)" @click.stop="onGet(marketplaceRow(item.slug)!)"><UseCaseIcon name="up" /> Update</button></td></tr>
          </tbody></table></div>
        </template>
        <template v-else>
          <div class="toolbar"><h1>{{ view === 'updates' ? 'Updates' : 'My Library' }}</h1><span>Use cases installed on this Desktop. Only active ones run.</span><div class="toolbar-actions"><button v-if="updateCount" class="button" @click="updateAll"><UseCaseIcon name="up" /> Update all ({{ updateCount }})</button><button class="button" @click="showBrowse"><UseCaseIcon name="grid" /> Browse Use Cases</button></div></div>
          <div v-if="libraryRows.length === 0" class="empty card"><b>{{ view === 'updates' ? 'Everything is up to date' : 'Your library is empty' }}</b><p v-if="view !== 'updates'">Browse Use Cases and pull one down.</p></div>
          <div v-else class="library-panes">
            <div class="card table-card"><table><thead><tr><th>Use case</th><th>Version</th><th>Source</th><th>Status</th></tr></thead><tbody>
              <template v-if="activeRows.length"><tr class="section-row"><td colspan="4">Active <span>{{ activeRows.length }}</span></td></tr><tr v-for="item in activeRows" :key="item.slug" class="item-row" :class="{ selected: selectedSlug === item.slug }" @click="selectedSlug = item.slug"><td><div class="name-cell"><span class="feature-icon" :class="topicTone(marketplaceRow(item.slug)?.topic || '')"><UseCaseIcon :name="marketplaceRow(item.slug) ? packageIcon(marketplaceRow(item.slug)!) : 'box'" /></span><div><b>{{ item.title }}</b><small>{{ marketplaceRow(item.slug) ? includesLine(marketplaceRow(item.slug)!) : item.name }}</small></div></div></td><td><code>{{ item.version }}</code></td><td><span>Installed package</span><small>{{ marketplaceRow(item.slug)?.publisher }}</small></td><td><span class="state" :class="{ active: item.active }"><i />{{ item.active ? 'Active' : 'Off' }}</span></td></tr></template>
              <template v-if="offRows.length"><tr class="section-row"><td colspan="4">Off <span>{{ offRows.length }}</span></td></tr><tr v-for="item in offRows" :key="item.slug" class="item-row" :class="{ selected: selectedSlug === item.slug }" @click="selectedSlug = item.slug"><td><div class="name-cell"><span class="feature-icon" :class="topicTone(marketplaceRow(item.slug)?.topic || '')"><UseCaseIcon :name="marketplaceRow(item.slug) ? packageIcon(marketplaceRow(item.slug)!) : 'box'" /></span><div><b>{{ item.title }}</b><small>{{ marketplaceRow(item.slug) ? includesLine(marketplaceRow(item.slug)!) : item.name }}</small></div></div></td><td><code>{{ item.version }}</code></td><td><span>Installed package</span><small>{{ marketplaceRow(item.slug)?.publisher }}</small></td><td><span class="state" :class="{ active: item.active }"><i />{{ item.active ? 'Active' : 'Off' }}</span></td></tr></template>
            </tbody></table></div>
            <aside v-if="selectedInstalled" class="card library-panel">
              <div class="panel-head"><span class="feature-icon" :class="topicTone(selectedMarketplace?.topic || '')"><UseCaseIcon :name="selectedMarketplace ? packageIcon(selectedMarketplace) : 'box'" /></span><div><h2>{{ selectedInstalled.title }}</h2><small>Installed {{ dateLabel(selectedInstalled.installedAt) }}</small></div><button v-if="selectedMarketplace" class="button small" @click="openPackage(selectedMarketplace)">Details</button></div>
              <div class="status-card" :class="{ active: selectedInstalled.active }"><div><i /><span><b>{{ selectedInstalled.active ? 'Active' : 'Off' }}</b><small>{{ selectedInstalled.active ? activeSummary : 'Nothing runs until you make it active.' }}</small></span></div><div class="status-actions"><button v-if="selectedInstalled.active && selectedMarketplace?.dashboardPort" class="button primary small" @click="openDashboard(selectedMarketplace.dashboardPort)"><UseCaseIcon name="external" /> Open dashboard</button><button v-if="selectedInstalled.active" class="button small" :disabled="Boolean(pk.busySlug.value)" @click="deactivate(selectedInstalled)"><UseCaseIcon name="pause" /> Deactivate</button><button v-else class="button primary small" :disabled="Boolean(pk.busySlug.value)" @click="openActivate(selectedInstalled)"><UseCaseIcon name="play" /> Make active</button></div></div>
              <div class="parts-heading"><b>Parts</b><span>{{ selectedMarketplace ? includesLine(selectedMarketplace) : '' }}</span></div>
              <div class="parts-list"><div v-for="group in selectedGroups" :key="group.kind" class="part-group"><h3>{{ group.label }} <span>{{ group.items.length }}</span></h3><div v-for="item in group.items" :key="item.slug" class="part-row"><span class="feature-icon" :class="kindTone(group.kind)"><UseCaseIcon :name="kindIcon(group.kind)" /></span><div><b>{{ item.name || item.slug }}</b><small v-if="item.description">{{ item.description }}</small><small v-else>{{ item.slug }}</small><code v-if="item.containers?.length">{{ item.containers.join(' · ') }}</code></div><span class="part-status">{{ itemStatus(group.kind, selectedInstalled.active) }}</span></div></div></div>
              <dl class="panel-meta"><div><dt>Version</dt><dd><code>{{ selectedInstalled.version }}</code></dd></div><div><dt>Source</dt><dd>{{ selectedMarketplace?.publisher || 'Installed package' }}</dd></div><div v-if="selectedMarketplace?.dashboardPort"><dt>Dashboard</dt><dd><code>localhost:{{ selectedMarketplace.dashboardPort }}</code></dd></div></dl>
              <div class="panel-bottom"><button class="button danger" @click="openUninstall(selectedInstalled)"><UseCaseIcon name="trash" /> Uninstall</button></div>
            </aside>
          </div>
        </template>
      </main>
    </section>

    <div v-if="activateTarget" class="scrim" @click.self="closeActivate"><div class="dialog">
      <header class="dialog-head"><span class="feature-icon red"><UseCaseIcon :name="selectedMarketplace ? packageIcon(selectedMarketplace) : 'box'" /></span><div><h2>Make {{ activateTarget.title }} active</h2><small>Version {{ activateTarget.version }}</small></div><button class="icon-button" @click="closeActivate"><UseCaseIcon name="close" /></button></header>
      <div class="wizard-tabs"><span v-for="(label, index) in ['Connect', 'Allow', 'Start']" :key="label" :class="{ current: activateStep === index + 1, done: activateStep > index + 1 }"><UseCaseIcon v-if="activateStep > index + 1" name="check" />{{ index + 1 }} · {{ label }}</span></div>
      <section v-if="activateStep === 1" class="dialog-body"><p>{{ activateTarget.title }} uses these accounts. Credentials stay in your Vault. Open Vault to add or review them; this screen does not claim whether they are ready.</p><div v-if="integrationItems.length" class="connections"><div v-for="item in integrationItems" :key="item.slug" class="connection"><span class="feature-icon amber"><UseCaseIcon name="key" /></span><div><b>{{ item.name || item.slug }}</b><small>Credential access is managed in Vault.</small></div><button class="button" @click="openVault(item.slug)"><UseCaseIcon name="key" /> Open Vault</button></div></div><div v-else class="honest">Nothing to connect. This use case doesn’t need any accounts.</div></section>
      <section v-else-if="activateStep === 2" class="dialog-body"><p>Here’s what switching this on lets your agents do. You can change it later in My Library.</p><div class="permissions"><div v-for="permission in permissions" :key="permission.title"><UseCaseIcon :name="permission.icon" /><span><b>{{ permission.title }}</b><small>{{ permission.description }}</small></span></div></div><label v-if="needsNetworkConsent" class="choice"><input v-model="networkConsent" type="checkbox"><span><b>I trust this network. Scan it.</b><small>This use case only scans after you approve the current trusted network.</small></span></label></section>
      <section v-else class="dialog-body"><div v-if="startError" class="banner error"><span class="banner-icon"><UseCaseIcon name="info" /></span><div><b>Couldn't start {{ activateTarget.title }}</b><small>{{ startError }}</small></div></div><div v-else class="starting-card" :class="{ complete: activationComplete }"><span :class="activationComplete ? 'complete-mark' : 'spinner'"><UseCaseIcon v-if="activationComplete" name="check" /></span><div><b>{{ activationComplete ? `${activateTarget.title} is active` : `Starting ${activateTarget.title}…` }}</b><small>{{ activationComplete ? activeSummary : 'Sulla is applying the package and starting its declared services.' }}</small></div></div><ul class="start-list"><li v-for="line in startLines" :key="line"><span :class="{ checked: activationComplete }"><UseCaseIcon v-if="activationComplete" name="check" /></span>{{ line }}<small v-if="activationComplete">ok</small></li></ul></section>
      <footer class="dialog-foot"><button v-if="activateStep > 1 && !starting && !activationComplete" class="button ghost" @click="activateStep--"><UseCaseIcon name="back" /> Back</button><span class="spacer" /><button v-if="!starting && !activationComplete" class="button" @click="closeActivate">Cancel</button><button v-if="activateStep < 3" class="button primary" :disabled="activateStep === 2 && needsNetworkConsent && !networkConsent" @click="activateStep++">{{ activateStep === 1 ? 'Continue' : 'Make active' }}</button><button v-else-if="!starting && !activationComplete" class="button primary" @click="startPackage"><UseCaseIcon name="play" /> Start</button><button v-else-if="activationComplete" class="button primary" @click="closeActivate">Done</button><span v-else class="working-label">Starting…</span></footer>
    </div></div>

    <div v-if="uninstallTarget" class="scrim" @click.self="uninstallTarget = null"><div class="dialog narrow"><header class="dialog-head"><div><h2>Uninstall {{ uninstallTarget.title }}?</h2></div><button class="icon-button" @click="uninstallTarget = null"><UseCaseIcon name="close" /></button></header><section class="dialog-body"><p>Removes its agents, skills, workflows and containers from this Desktop and My Library. Vault credentials are not touched.</p><label class="choice"><input v-model="removeData" :value="false" type="radio"><span><b>Keep my data</b><small>Stops containers and keeps named Docker volumes. Reinstalling picks them back up.</small></span></label><label class="choice danger-choice"><input v-model="removeData" :value="true" type="radio"><span><b>Also remove data</b><small>Deletes named Docker volumes. This can’t be undone.</small></span></label></section><footer class="dialog-foot"><span class="spacer" /><button class="button" @click="uninstallTarget = null">Cancel</button><button class="button danger filled" :disabled="Boolean(pk.busySlug.value)" @click="confirmUninstall"><UseCaseIcon name="trash" /> Uninstall</button></footer></div></div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { loadPackageTopics, packageTopicLabel, usePackageTopics } from '@pkg/composables/packageTopics';
import { packageMatches, usePackages, type InstalledPackage, type PackageContentItem, type PackageRow } from '@pkg/composables/usePackages';

import PackageDetail from './PackageDetail.vue';
import { USE_CASE_SECTIONS, type StudioSection } from './studioSections';
import UseCaseIcon from './UseCaseIcon.vue';

const props = withDefaults(defineProps<{ section?: StudioSection }>(), { section: 'browse' });
const emit = defineEmits<{ (e: 'installed'): void; (e: 'feedback', kind: 'success' | 'error' | 'info', message: string): void; (e: 'update:section', section: StudioSection): void }>();
const router = useRouter();
const pk = usePackages();
const topics = usePackageTopics();
const view = ref<StudioSection>(props.section);
const isUseCaseView = computed(() => USE_CASE_SECTIONS.includes(view.value));
watch(() => props.section, (section) => { if (section !== view.value) { view.value = section; pk.clearDetail(); } });
watch(view, section => emit('update:section', section));
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
const activationComplete = ref(false);
const startError = ref('');
const uninstallTarget = ref<InstalledPackage | null>(null);
const removeData = ref(false);

const filtered = computed(() => pk.packages.value.filter(item => packageMatches(item, query.value) && (!selectedTopic.value || item.topic === selectedTopic.value)));
const suggestions = computed(() => pk.packages.value.filter(item => packageMatches(item, query.value)).slice(0, 5));
const showSuggestions = computed(() => searchFocused.value && query.value.trim().length > 0 && suggestions.value.length > 0);
const topicRows = computed(() => topics.value.map(topic => ({ ...topic, count: pk.packages.value.filter(item => item.topic === topic.key).length })).filter(topic => topic.count));
const browseGroups = computed(() => {
  if (query.value || selectedTopic.value) return [{ label: selectedTopic.value ? topicLabel(selectedTopic.value) : 'Results', items: filtered.value }];
  const featured = filtered.value.slice(0, 4);
  const used = new Set(featured.map(item => item.id));
  const groups: { label: string; items: PackageRow[] }[] = [{ label: 'Featured', items: featured }];
  topicRows.value.forEach(topic => {
    const items = filtered.value.filter(item => item.topic === topic.key && !used.has(item.id));
    if (items.length) { groups.push({ label: `More in ${topic.label}`, items }); items.forEach(item => used.add(item.id)); }
  });
  const rest = filtered.value.filter(item => !used.has(item.id));
  if (rest.length) groups.push({ label: 'More use cases', items: rest });
  return groups;
});
const updateCount = computed(() => pk.installed.value.filter(item => marketplaceRow(item.slug)?.version !== item.version).length);
const libraryRows = computed(() => view.value === 'updates' ? pk.installed.value.filter(item => marketplaceRow(item.slug)?.version !== item.version) : pk.installed.value);
const activeRows = computed(() => libraryRows.value.filter(item => item.active));
const offRows = computed(() => libraryRows.value.filter(item => !item.active));
const selectedInstalled = computed(() => pk.installed.value.find(item => item.slug === selectedSlug.value) ?? pk.installed.value[0] ?? null);
const selectedMarketplace = computed(() => selectedInstalled.value ? marketplaceRow(selectedInstalled.value.slug) : undefined);
const selectedGroups = computed(() => groupItems(selectedMarketplace.value?.contents ?? selectedInstalled.value?.items ?? []));
const integrationItems = computed(() => selectedMarketplace.value?.contents.filter(item => item.kind === 'integration') ?? activateTarget.value?.items.filter(item => item.kind === 'integration') ?? []);
const needsNetworkConsent = computed(() => { const manifest: any = activateTarget.value?.manifest ?? {}; return manifest.permissions?.network_scan === true || manifest.permissions?.networkScan === true || manifest.network_scan === true; });
const permissions = computed(() => {
  const items = selectedMarketplace.value?.contents ?? [];
  const lines = items.filter(item => ['agent', 'routine', 'recipe'].includes(item.kind)).map(item => ({
    icon: kindIcon(item.kind), title: item.kind === 'agent' ? `${item.name || item.slug} joins your agents` : item.kind === 'routine' ? `Runs “${item.name || item.slug}”` : `Starts ${item.containers.length || 'declared'} containers on this Desktop`, description: item.description || item.slug,
  }));
  if (!lines.length) lines.push({ icon: 'check', title: 'Makes this package available to Sulla', description: 'Its declared parts become active on this Desktop.' });
  return lines;
});
const startLines = computed(() => { const lines = ['Link credentials from Vault', 'Add agents and skills', 'Schedule workflows']; if (selectedMarketplace.value?.contents.some(item => item.kind === 'recipe')) lines.push('Start recipe containers'); lines.push('Refresh Sulla runtime catalogs', 'Active'); return lines; });
const browseSubtitle = computed(() => selectedTopic.value ? `${filtered.value.length} ready-made job${filtered.value.length === 1 ? '' : 's'}` : 'Ready-made jobs for your agents. Pull one down, then switch it on.');
const activeSummary = computed(() => selectedMarketplace.value?.contents.some(item => item.kind === 'recipe') ? 'Containers running · workflows scheduled' : 'Workflows scheduled · agent available');

function topicLabel(key: string) { return packageTopicLabel(key) || key || 'Other'; }
function topicTone(value: string) { return /security|it/i.test(value) ? 'red' : /field/i.test(value) ? 'amber' : /sales|marketing|growth/i.test(value) ? 'purple' : /office/i.test(value) ? 'green' : 'blue'; }
function packageIcon(item: PackageRow) { const text = `${item.icon} ${item.slug} ${item.title}`; if (/shield|guard|security/i.test(text)) return 'shield'; if (/mail|inbox/i.test(text)) return 'mail'; if (/meeting|calendar/i.test(text)) return 'calendar'; return 'box'; }
function kindIcon(kind: string) { return ({ agent: 'agent', skill: 'skill', routine: 'workflow', function: 'function', integration: 'integration', recipe: 'recipe' } as Record<string, string>)[kind] || 'box'; }
function kindTone(kind: string) { return ({ agent: 'blue', skill: 'purple', routine: 'green', function: 'purple', integration: 'amber', recipe: 'red' } as Record<string, string>)[kind] || 'blue'; }
function installed(slug: string) { return pk.installed.value.find(item => item.slug === slug); }
function marketplaceRow(slug: string) { return pk.packages.value.find(item => item.slug === slug); }
function groupItems(items: ({ kind: string; slug: string } | PackageContentItem)[]) { const labels: Record<string, string> = { agent: 'Agents', skill: 'Skills', routine: 'Workflows', function: 'Functions', integration: 'Integrations', recipe: 'Recipes' }; return Object.entries(labels).map(([kind, label]) => ({ kind, label, items: items.filter(item => item.kind === kind) })).filter(group => group.items.length); }
function includesLine(item: PackageRow) { return groupItems(item.contents).map(group => `${group.items.length} ${group.items.length === 1 ? group.label.toLowerCase().slice(0, -1) : group.label.toLowerCase()}`).join(' · ') || 'Open to see what’s included'; }
function dateLabel(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function itemStatus(kind: string, active: boolean) { if (kind === 'integration') return 'Open Vault'; if (kind === 'recipe') return active ? 'Running' : 'Stopped'; return active ? 'Available' : 'Off'; }
function onSearchBlur() { window.setTimeout(() => { searchFocused.value = false; }, 120); }
function showSection(section: StudioSection) { view.value = section; pk.clearDetail(); }
function showBrowse() { view.value = 'browse'; selectedTopic.value = ''; pk.clearDetail(); }
function showLibrary() { view.value = 'library'; pk.clearDetail(); selectedSlug.value ||= pk.installed.value[0]?.slug ?? null; }
function showUpdates() { view.value = 'updates'; pk.clearDetail(); }
function selectTopic(key: string) { view.value = 'browse'; selectedTopic.value = key; pk.clearDetail(); }
function openPackage(item: PackageRow) { searchFocused.value = false; void pk.loadDetail(item.id); }
function openInstalled(slug: string) { pk.clearDetail(); view.value = 'library'; selectedSlug.value = slug; }
function publishUseCase() { void router.push('/Routines'); emit('feedback', 'info', 'Publish a package from Sulla Studio.'); }
function openVault(slug: string) { void router.push(`/Integrations/${encodeURIComponent(slug)}`); }
function openDashboard(port: number) { window.open(`http://localhost:${port}`, '_blank', 'noopener'); }
async function onGet(row: PackageRow) { download.value = { name: row.title }; const result = await pk.install(row); download.value = null; if (result.ok) { feedback.value = { kind: 'success', message: `${row.title} is in My Library.` }; emit('installed'); openInstalled(row.slug); } else feedback.value = { kind: 'error', message: result.error || `Couldn't get ${row.title}.` }; }
function openActivate(item: InstalledPackage) { activateTarget.value = item; selectedSlug.value = item.slug; activateStep.value = 1; networkConsent.value = false; starting.value = false; activationComplete.value = false; startError.value = ''; }
function closeActivate() { if (!starting.value) activateTarget.value = null; }
async function startPackage() { if (!activateTarget.value) return; starting.value = true; startError.value = ''; const target = activateTarget.value; const result = await pk.setActive(target.slug, true); starting.value = false; if (result.ok) { activationComplete.value = true; selectedSlug.value = target.slug; feedback.value = { kind: 'success', message: `${target.title} is active.` }; } else startError.value = result.error || `Couldn't start ${target.title}.`; }
async function deactivate(item: InstalledPackage) { const result = await pk.setActive(item.slug, false); feedback.value = result.ok ? { kind: 'success', message: `${item.title} is off.` } : { kind: 'error', message: result.error || `Couldn't deactivate ${item.title}.` }; }
function openUninstall(item: InstalledPackage) { uninstallTarget.value = item; removeData.value = false; }
async function confirmUninstall() { if (!uninstallTarget.value) return; const target = uninstallTarget.value; const result = await pk.uninstall(target.slug, removeData.value); if (result.ok) { uninstallTarget.value = null; selectedSlug.value = null; feedback.value = { kind: 'success', message: `${target.title} uninstalled${removeData.value ? ' and data removed' : '; data kept'}.` }; emit('installed'); } else feedback.value = { kind: 'error', message: result.error || `Couldn't uninstall ${target.title}.` }; }
async function updateAll() { for (const item of libraryRows.value) { const row = marketplaceRow(item.slug); if (row) await onGet(row); } }

onMounted(async() => { await Promise.all([pk.load(), pk.loadInstalled(), loadPackageTopics()]); selectedSlug.value = pk.installed.value[0]?.slug ?? null; });
</script>

<style scoped>
.use-cases { --uc-bg: var(--nx-paper, #f3f6fa); --uc-paper: var(--nx-paper-2, #f7f9fb); --uc-card: var(--nx-card, #fff); --uc-text: var(--nx-read-1, #1d2a3b); --uc-muted: var(--nx-read-3, #5d6c82); --uc-dim: var(--nx-read-4, #8794a8); --uc-line: var(--nx-hair, #dfe4ea); --uc-line-strong: var(--nx-line, #d4dae2); --uc-accent: var(--nx-accent, #3d87a7); --uc-accent-soft: var(--nx-accent-soft, #e8f2f6); --uc-accent-line: var(--nx-accent-line, #a9cddd); --uc-success: var(--nx-success, #1c9d58); --uc-danger: var(--nx-danger, #dc3c3c); --uc-shadow: 0 8px 24px rgb(26 35 50 / 5%); display: grid; grid-template-columns: 224px minmax(0, 1fr); min-height: 760px; overflow: hidden; border-radius: 10px; background: var(--uc-bg); color: var(--uc-text); font: 13px var(--font-body, system-ui, sans-serif); }
button, input { font: inherit; }.rail { display: flex; flex-direction: column; padding: 18px 14px; border-right: 1px solid var(--uc-line); background: color-mix(in srgb, var(--uc-card) 58%, transparent); }.brand { display: flex; align-items: center; gap: 10px; padding: 6px 8px 22px; }.brand-mark { display: grid; place-items: center; width: 29px; height: 29px; border-radius: 8px; background: linear-gradient(135deg, #4f97b4, #18384a); color: white; font-weight: 700; }.brand b, .brand small { display: block; }.brand small { margin-top: 2px; color: var(--uc-dim); font-size: 10px; }.nav-list { display: grid; gap: 3px; }.nav-list button { display: grid; grid-template-columns: 18px 1fr auto; align-items: center; gap: 8px; padding: 8px 10px; border: 0; border-radius: 9px; background: transparent; color: var(--uc-muted); text-align: left; cursor: pointer; }.nav-list button :deep(svg) { font-size: 15px; }.nav-list button.selected { background: var(--uc-accent-soft); color: var(--uc-accent); font-weight: 600; }.nav-list button b { padding: 2px 6px; border-radius: 9px; background: rgb(29 42 59 / 5%); font-size: 11px; }.nav-list button b.warning { background: #fff0cf; color: #c47a00; }.rail-separator { width: 100%; margin: 14px 0; border: 0; border-top: 1px solid var(--uc-line); }.rail-spacer { flex: 1; }.workspace { min-width: 0; }.topbar { display: grid; grid-template-columns: minmax(60px, auto) minmax(300px, 560px) 1fr; align-items: center; gap: 16px; height: 58px; padding: 0 28px; border-bottom: 1px solid var(--uc-line); background: color-mix(in srgb, var(--uc-card) 68%, transparent); }.crumbs { display: flex; align-items: center; gap: 8px; white-space: nowrap; }.crumbs button { padding: 0; border: 0; background: none; color: var(--uc-muted); cursor: pointer; }.crumbs span { color: var(--uc-dim); }.search-wrap { position: relative; display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px; border: 1px solid var(--uc-line-strong); border-radius: 10px; background: var(--uc-card); }.search-wrap > :deep(svg) { color: var(--uc-dim); }.search-wrap input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--uc-text); }.search-wrap kbd { padding: 2px 5px; border: 1px solid var(--uc-line-strong); border-radius: 5px; color: var(--uc-dim); font-size: 10px; }.suggestions { position: absolute; z-index: 20; top: 40px; right: 0; left: 0; padding: 5px; border: 1px solid var(--uc-line); border-radius: 10px; background: var(--uc-card); box-shadow: 0 14px 36px rgb(26 35 50 / 20%); }.suggestions button { display: grid; grid-template-columns: 30px 1fr auto; align-items: center; gap: 9px; width: 100%; padding: 8px; border: 0; border-radius: 7px; background: transparent; color: var(--uc-text); text-align: left; }.suggestions button:hover { background: var(--uc-paper); }.suggestions b, .suggestions small { display: block; }.suggestions small, .suggestions em { overflow: hidden; color: var(--uc-dim); font-size: 10px; font-style: normal; text-overflow: ellipsis; white-space: nowrap; }.publish { justify-self: end; }.content { padding: 22px 28px 56px; }.toolbar { display: flex; align-items: baseline; gap: 10px; margin-bottom: 16px; }.toolbar h1 { margin: 0; font-size: 20px; }.toolbar > span { color: var(--uc-dim); }.toolbar-actions { display: flex; gap: 8px; margin-left: auto; }.button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 32px; padding: 0 13px; border: 1px solid var(--uc-line-strong); border-radius: 8px; background: var(--uc-card); color: var(--uc-text); cursor: pointer; }.button:hover { border-color: var(--uc-accent); }.button.small { min-height: 26px; padding: 0 9px; font-size: 12px; }.button.primary { border-color: var(--uc-accent); background: var(--uc-accent); color: white; }.button.ghost { border-color: transparent; background: transparent; }.button.danger { border-color: color-mix(in srgb, var(--uc-danger) 36%, var(--uc-line)); color: var(--uc-danger); }.button.danger.filled { border-color: var(--uc-danger); background: var(--uc-danger); color: white; }.button:disabled { cursor: wait; opacity: .55; }.button :deep(svg) { width: 14px; height: 14px; }.icon-button { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; background: transparent; color: var(--uc-muted); cursor: pointer; }.card { border: 1px solid var(--uc-line); border-radius: 12px; background: var(--uc-card); box-shadow: var(--uc-shadow); }.table-card { overflow: hidden; }table { width: 100%; border-collapse: collapse; }th { padding: 9px 14px; border-bottom: 1px solid var(--uc-line); color: var(--uc-dim); font-size: 10px; letter-spacing: .07em; text-align: left; text-transform: uppercase; }td { padding: 10px 14px; border-bottom: 1px solid var(--uc-line); color: var(--uc-muted); font-size: 12.5px; }td > span + small { display: block; color: var(--uc-dim); font-size: 11px; }.section-row td { padding: 12px 14px 7px; color: var(--uc-dim); font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }.section-row span { float: right; }.item-row { cursor: pointer; }.item-row:hover td, .item-row.selected td { background: var(--uc-accent-soft); }.name-cell { display: flex; align-items: center; gap: 10px; color: var(--uc-text); }.name-cell b, .name-cell small { display: block; }.name-cell b { font-size: 13.5px; font-weight: 500; }.name-cell small { max-width: 500px; color: var(--uc-dim); font-size: 11px; }.feature-icon { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 8px; font-size: 16px; }.feature-icon.blue { color: #277da1; background: #e5f0f5; }.feature-icon.red { color: #e13d36; background: #fbe9e9; }.feature-icon.green { color: #1e9558; background: #e3f4ea; }.feature-icon.amber { color: #c27a0b; background: #fbf0dd; }.feature-icon.purple { color: #7656d8; background: #eee9fa; }.dashboard { display: flex; align-items: center; gap: 5px; margin-top: 3px; color: var(--uc-accent); font-size: 11px; }.publisher { white-space: nowrap; }.row-action { text-align: right; }.state { white-space: nowrap; font-size: 12px; }.state i { display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; background: #9aa8b8; }.state.active { color: var(--uc-success); }.state.active i { background: var(--uc-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--uc-success) 12%, transparent); }.empty { padding: 70px 20px; color: var(--uc-muted); text-align: center; }.empty b { display: block; color: var(--uc-text); font-size: 15px; }.banner { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; padding: 10px 12px; border: 1px solid var(--uc-accent-line); border-radius: 9px; background: var(--uc-accent-soft); }.banner > div { min-width: 0; flex: 1; }.banner b, .banner small { display: block; }.banner small { color: var(--uc-muted); }.banner.error { border-color: color-mix(in srgb, var(--uc-danger) 35%, var(--uc-line)); background: color-mix(in srgb, var(--uc-danger) 7%, var(--uc-card)); }.banner-icon { display: grid; place-items: center; width: 28px; height: 28px; flex: none; border-radius: 7px; background: var(--uc-card); color: var(--uc-accent); }.indeterminate { height: 4px; margin-top: 7px; overflow: hidden; border-radius: 4px; background: var(--uc-line); }.indeterminate i { display: block; width: 35%; height: 100%; background: var(--uc-accent); animation: progress 1.1s ease-in-out infinite; }@keyframes progress { from { transform: translateX(-100%); } to { transform: translateX(390%); } }.library-panes { display: grid; grid-template-columns: minmax(0, 1fr) 380px; align-items: start; gap: 16px; }.library-panel { overflow: hidden; }.panel-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--uc-line); }.panel-head > div { min-width: 0; flex: 1; }.panel-head h2 { margin: 0; font-size: 13px; }.panel-head small { color: var(--uc-dim); font-size: 11px; }.status-card { margin: 12px 16px 0; padding: 12px 14px; border: 1px solid var(--uc-line-strong); border-radius: 10px; background: var(--uc-paper); }.status-card.active { border-color: color-mix(in srgb, var(--uc-success) 35%, transparent); background: color-mix(in srgb, var(--uc-success) 10%, var(--uc-card)); }.status-card > div:first-child { display: flex; align-items: center; gap: 10px; }.status-card i { width: 8px; height: 8px; border-radius: 50%; background: #9aa8b8; }.status-card.active i { background: var(--uc-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--uc-success) 12%, transparent); }.status-card b, .status-card small { display: block; }.status-card small { color: var(--uc-muted); }.status-actions { display: flex; gap: 8px; margin-top: 10px; padding-left: 18px; }.parts-heading { display: flex; justify-content: space-between; padding: 16px 16px 8px; }.parts-heading span { color: var(--uc-dim); font-size: 11px; }.parts-list { padding: 0 16px; }.part-group h3 { margin: 10px 0 4px; padding-bottom: 4px; border-bottom: 1px solid var(--uc-line); color: var(--uc-dim); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }.part-group h3 span { margin-left: 5px; font-weight: 400; }.part-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--uc-line); }.part-row > div { min-width: 0; flex: 1; }.part-row b, .part-row small, .part-row code { display: block; }.part-row b { font-weight: 500; }.part-row small, .part-row code, .part-status { color: var(--uc-dim); font-size: 11px; }.part-status { white-space: nowrap; }.panel-meta { margin: 8px 0 0; padding: 6px 16px 10px; border-top: 1px solid var(--uc-line); }.panel-meta > div { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid var(--uc-line); }.panel-meta dt { color: var(--uc-dim); }.panel-meta dd { margin: 0; text-align: right; }.panel-bottom { padding: 12px 16px 16px; border-top: 1px solid var(--uc-line); }.scrim { position: fixed; z-index: 100; inset: 0; display: grid; place-items: center; background: rgb(26 35 50 / 35%); }.dialog { display: flex; flex-direction: column; width: min(720px, 92vw); max-height: 88vh; overflow: hidden; border: 1px solid var(--uc-line-strong); border-radius: 12px; background: var(--uc-card); box-shadow: 0 22px 70px rgb(0 0 0 / 28%); }.dialog.narrow { width: min(480px, 92vw); }.dialog-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--uc-line); }.dialog-head > div { flex: 1; }.dialog-head h2 { margin: 0; font-size: 15px; }.dialog-head small { color: var(--uc-dim); }.wizard-tabs { display: flex; gap: 6px; padding: 12px 18px 0; }.wizard-tabs span { display: flex; align-items: center; justify-content: center; gap: 5px; flex: 1; padding: 7px 8px; border: 1px solid var(--uc-line); border-radius: 7px; background: var(--uc-paper); color: var(--uc-dim); font-size: 11.5px; }.wizard-tabs span.current { border-color: var(--uc-accent-line); background: var(--uc-accent-soft); color: var(--uc-accent); font-weight: 600; }.wizard-tabs span.done { color: var(--uc-success); }.dialog-body { overflow: auto; padding: 16px 18px; color: var(--uc-muted); }.dialog-body > p { margin: 0 0 12px; }.dialog-foot { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--uc-line); }.spacer { flex: 1; }.connections { display: grid; gap: 10px; }.connection { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 1px solid var(--uc-line-strong); border-radius: 10px; }.connection > div { flex: 1; }.connection b, .connection small { display: block; }.connection small { color: var(--uc-muted); }.honest { padding: 12px 14px; border: 1px solid var(--uc-line); border-radius: 9px; background: var(--uc-paper); }.permissions > div { display: flex; gap: 10px; padding: 10px 0; border-top: 1px solid var(--uc-line); }.permissions > div:first-child { border-top: 0; }.permissions :deep(svg) { width: 17px; height: 17px; flex: none; color: var(--uc-accent); }.permissions b, .permissions small { display: block; }.permissions small { color: var(--uc-muted); }.choice { display: flex; align-items: flex-start; gap: 10px; margin-top: 10px; padding: 12px 14px; border: 1px solid var(--uc-line-strong); border-radius: 10px; color: var(--uc-text); cursor: pointer; }.choice:has(input:checked) { border-color: var(--uc-accent-line); background: var(--uc-accent-soft); }.choice input { margin-top: 3px; accent-color: var(--uc-accent); }.choice b, .choice small { display: block; }.choice small { margin-top: 3px; color: var(--uc-muted); }.danger-choice:has(input:checked) { border-color: color-mix(in srgb, var(--uc-danger) 35%, transparent); background: color-mix(in srgb, var(--uc-danger) 7%, var(--uc-card)); }.starting-card { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 1px solid var(--uc-accent-line); border-radius: 9px; background: var(--uc-accent-soft); }.starting-card.complete { border-color: color-mix(in srgb, var(--uc-success) 35%, transparent); background: color-mix(in srgb, var(--uc-success) 8%, var(--uc-card)); }.starting-card b, .starting-card small { display: block; }.complete-mark { display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--uc-success); color: white; }.spinner { display: block; width: 18px; height: 18px; flex: none; border: 2px solid var(--uc-line-strong); border-top-color: var(--uc-accent); border-radius: 50%; animation: spin .8s linear infinite; }@keyframes spin { to { transform: rotate(360deg); } }.start-list { margin: 10px 0 0; padding: 0; list-style: none; }.start-list li { display: flex; align-items: center; gap: 9px; padding: 5px 0; color: var(--uc-muted); }.start-list li > span { display: grid; place-items: center; width: 16px; height: 16px; flex: none; border: 1.5px solid var(--uc-line-strong); border-radius: 50%; }.start-list li > span.checked { border-color: var(--uc-success); background: var(--uc-success); color: white; }.start-list li small { margin-left: auto; color: var(--uc-dim); font: 11px var(--font-mono, monospace); }.working-label { color: var(--uc-dim); }@media (max-width: 950px) { .use-cases { grid-template-columns: 180px 1fr; }.topbar { grid-template-columns: auto 1fr; }.publish { display: none; }.library-panes { grid-template-columns: 1fr; }th:nth-child(2), td:nth-child(2) { display: none; } }

/* Studio shell: the sidebar stays put and each page scrolls on its own. */
.use-cases { height: 100%; min-height: 0; grid-template-rows: minmax(0, 1fr); }
.rail { min-height: 0; overflow: auto; }
.workspace { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.content { flex: 1; min-height: 0; overflow: auto; }
.section-host { overflow: hidden; }
.available { color: var(--uc-accent); }
</style>
