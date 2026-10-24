<template>
  <div class="studio-page">
    <StudioTopbar :crumbs="active ? ['Recipes', active.name] : ['Recipes']" v-model:search="search" search-placeholder="Search recipes" @crumb="closeDetail" />
    <div class="studio-content">
      <template v-if="!active">
        <div class="tb"><h1>Recipes</h1><span>Docker apps that run on this Desktop · {{ recipes.length }} installed</span></div>
        <div v-if="error" class="banner error"><div>{{ error }}</div><button class="btn sm" @click="load">Try again</button></div>
        <div v-else-if="loading" class="card empty">Loading recipes…</div>
        <div v-else-if="filtered.length === 0" class="card empty"><b>Nothing here yet.</b><span>{{ search ? 'No recipes match your search.' : 'Installed recipes will appear here.' }}</span></div>
        <div v-else class="card"><table><thead><tr><th>Recipe</th><th>Containers</th><th>Status</th><th>Dashboard</th><th></th></tr></thead><tbody><tr v-for="recipe in filtered" :key="recipe.slug" class="click" @click="openRecipe(recipe)"><td><div class="name"><span class="fi amber">⬡</span><div><b>{{ recipe.name }}</b><small>{{ recipe.description || 'No description' }}</small></div></div></td><td>{{ containerLabel(statuses[recipe.slug]) }}</td><td><span class="st" :class="statusClass(statuses[recipe.slug])"><i />{{ statusLabel(statuses[recipe.slug]) }}</span></td><td><button v-if="primaryPort(statuses[recipe.slug])" class="btn sm ghost" :disabled="!statuses[recipe.slug]?.running" @click.stop="openDashboard(statuses[recipe.slug])">localhost:{{ primaryPort(statuses[recipe.slug]) }} ↗</button><span v-else>—</span></td><td class="right"><button class="btn sm" @click.stop="openRecipe(recipe, 'logs')">Logs</button> <button class="btn sm" :class="{ pri: !statuses[recipe.slug]?.running }" :disabled="actions[recipe.slug]" @click.stop="statuses[recipe.slug]?.running ? stop(recipe.slug) : start(recipe.slug)">{{ statuses[recipe.slug]?.running ? 'Stop' : 'Start' }}</button></td></tr></tbody></table></div>
        <p class="hint">Stopping a recipe keeps its data. Open a row for logs, a shell and container details.</p>
      </template>
      <template v-else>
        <button class="back" @click="closeDetail">‹ Recipes</button>
        <div class="card hero"><span class="fi amber big">⬡</span><div><h1>{{ active.name }}</h1><p>{{ active.description }}</p><div class="meta"><span class="st" :class="statusClass(activeStatus)"><i />{{ statusLabel(activeStatus) }}</span><span v-if="active.version">v{{ active.version }}</span></div></div><div class="acts"><button v-if="activeStatus?.running" class="btn" :disabled="!!actions[active.slug]" @click="restart(active.slug)">↻ Restart</button><button class="btn" :class="{ pri: !activeStatus?.running }" :disabled="!!actions[active.slug]" @click="activeStatus?.running ? stop(active.slug) : start(active.slug)">{{ activeStatus?.running ? '■ Stop' : '▶ Start' }}</button><button v-if="primaryPort(activeStatus)" class="btn pri" :disabled="!activeStatus?.running" @click="openDashboard(activeStatus)">Open dashboard ↗</button></div></div>
        <div v-if="actionMessage" class="banner" :class="{ error: actionError }"><div>{{ actionMessage }}</div></div>
        <div class="tabs"><button :class="{ on: tab === 'overview' }" @click="tab = 'overview'">Overview</button><button :class="{ on: tab === 'logs' }" @click="tab = 'logs'">Logs</button><button :class="{ on: tab === 'shell' }" @click="tab = 'shell'">Shell</button></div>
        <div v-if="tab === 'overview'" class="dgrid"><div><div class="card"><div class="sec-title"><h2>Services</h2><small>{{ activeStatus?.containers.length ?? 0 }} containers</small></div><table><thead><tr><th>Service</th><th>Status</th><th>Ports</th></tr></thead><tbody><tr v-for="container in activeStatus?.containers ?? []" :key="container.name"><td><b>{{ container.service }}</b><small class="mono">{{ container.name }}</small></td><td><span class="st" :class="container.state === 'running' ? 'ok' : ''"><i />{{ container.status || container.state }}</span></td><td class="mono">{{ container.ports.join(', ') || '—' }}</td></tr><tr v-if="!activeStatus?.containers.length"><td colspan="3">No containers are defined.</td></tr></tbody></table></div><div class="card recent"><div class="sec-title"><h2>Recent logs</h2><small>live output</small></div><div class="terminal"><RecipeLogs :slug="active.slug" /></div></div></div><aside class="card side"><h3>Ports</h3><div v-for="port in activeStatus?.webPorts ?? []" :key="port" class="kv"><span>Web</span><button class="btn sm ghost mono" @click="openPort(port)">{{ port }} ↗</button></div><div v-if="!activeStatus?.webPorts?.length" class="kv"><span>Web</span><b>—</b></div><h3>Details</h3><div class="kv"><span>Slug</span><b class="mono">{{ active.slug }}</b></div><div v-if="active.image" class="kv"><span>Image</span><b class="mono">{{ active.image }}</b></div><div v-if="active.extension" class="kv"><span>Extension</span><b>{{ active.extension }}</b></div></aside></div>
        <div v-else-if="tab === 'logs'" class="card terminal full"><RecipeLogs :slug="active.slug" /></div>
        <div v-else class="card terminal full"><RecipeShell :slug="active.slug" :containers="activeStatus?.containers ?? []" /></div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import RecipeLogs from '@pkg/components/recipes/RecipeLogs.vue';
import RecipeShell from '@pkg/components/recipes/RecipeShell.vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import StudioTopbar from './StudioTopbar.vue';
interface Recipe { slug: string; name: string; description: string; version: string; image?: string; extension?: string; updatedAt: string }
interface Container { name: string; service: string; state: string; status: string; ports: string[] }
interface RecipeStatus { running: boolean; containers: Container[]; webPorts?: number[]; error?: string }
const recipes = ref<Recipe[]>([]); const statuses = reactive<Record<string, RecipeStatus | undefined>>({}); const actions = reactive<Record<string, boolean>>({}); const search = ref(''); const loading = ref(true); const error = ref(''); const active = ref<Recipe | null>(null); const tab = ref<'overview'|'logs'|'shell'>('overview'); const actionMessage = ref(''); const actionError = ref(false); let timer: ReturnType<typeof setInterval> | undefined;
const filtered = computed(() => { const q = search.value.trim().toLowerCase(); return q ? recipes.value.filter(r => `${r.name} ${r.description} ${r.slug}`.toLowerCase().includes(q)) : recipes.value; }); const activeStatus = computed(() => active.value ? statuses[active.value.slug] : undefined);
function statusLabel(status?: RecipeStatus) { return !status ? 'Checking…' : status.error ? 'Unavailable' : status.running ? 'Running' : 'Stopped'; }
function statusClass(status?: RecipeStatus) { return status?.error ? 'bad' : status?.running ? 'ok' : ''; }
function containerLabel(status?: RecipeStatus) { if (!status) return 'Checking…'; if (!status.containers.length) return '—'; return `${status.containers.length} · ${status.containers.map(c => c.service).join(', ')}`; }
function extractPort(value: string | number) { return String(value).match(/\d+/)?.[0] ?? ''; }
function primaryPort(status?: RecipeStatus) { return status?.webPorts?.[0] ? extractPort(status.webPorts[0]) : ''; }
async function refresh(slug: string) { statuses[slug] = await ipcRenderer.invoke('recipe-docker-status', slug); }
async function refreshAll() { await Promise.all(recipes.value.map(r => refresh(r.slug))); }
async function load() { loading.value = true; error.value = ''; try { recipes.value = await ipcRenderer.invoke('library-list-recipes') as Recipe[]; await refreshAll(); } catch (e) { error.value = e instanceof Error ? e.message : String(e); } finally { loading.value = false; } }
function openRecipe(recipe: Recipe, nextTab: 'overview'|'logs'|'shell' = 'overview') { active.value = recipe; tab.value = nextTab; actionMessage.value = ''; void refresh(recipe.slug); }
function closeDetail() { active.value = null; actionMessage.value = ''; }
async function start(slug: string) { actions[slug] = true; actionMessage.value = ''; try { const result = await ipcRenderer.invoke('recipe-start-stream', slug); actionMessage.value = `Starting recipe (${result.sessionId}).`; actionError.value = false; setTimeout(() => void refresh(slug), 1200); } catch (e) { actionError.value = true; actionMessage.value = e instanceof Error ? e.message : String(e); } finally { actions[slug] = false; } }
async function stop(slug: string) { actions[slug] = true; const result = await ipcRenderer.invoke('recipe-stop', slug); actions[slug] = false; actionError.value = !result.ok; actionMessage.value = result.ok ? 'Recipe stopped.' : result.error ?? result.stderr ?? 'Could not stop recipe.'; await refresh(slug); }
async function restart(slug: string) { await stop(slug); if (!actionError.value) await start(slug); }
// Recipe dashboards open in the Sulla browser, like the Use Cases dashboard link.
function openPort(port: string | number) { const n = extractPort(port); if (n) window.open(`http://localhost:${n}`, '_blank', 'noopener'); }
function openDashboard(status?: RecipeStatus) { const port = primaryPort(status); if (port) openPort(port); }
onMounted(async() => { await load(); timer = setInterval(() => void refreshAll(), 10000); }); onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<style scoped lang="scss">
@import '@pkg/assets/styles/studio-ui.scss';
.hint { margin-top: 14px; color: var(--uc-dim); }
.recent { margin-top: 16px; }
.terminal { height: 300px; min-height: 0; padding: 10px; background: var(--uc-paper); }
.terminal.full { height: calc(100% - 130px); min-height: 360px; }
</style>
