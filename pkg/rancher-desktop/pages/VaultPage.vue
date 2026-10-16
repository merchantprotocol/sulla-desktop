<template>
  <main class="vault-page">
    <header class="vault-head">
      <div class="head-copy">
        <span class="eyebrow">PASSWORD VAULT</span><h1>Your passwords, locked and yours.</h1><p>Sulla's agents can only use the ones you switch on.</p>
      </div>
      <span class="status"><i :class="{ off: !unlocked }" />{{ unlocked ? 'Unlocked' : 'Locked' }}</span>
      <label class="search">⌕<input
        v-model="query"
        placeholder="Search items"
      ><kbd>⌘K</kbd></label>
      <div class="new-wrap">
        <button
          class="primary"
          @click="newMenu = !newMenu"
        >
          ＋ New item
        </button><div
          v-if="newMenu"
          class="menu"
        >
          <button
            v-for="type in itemTypes"
            :key="type.value"
            @click="startCreate(type.value)"
          >
            {{ type.icon }} {{ type.label }}
          </button>
        </div>
      </div>
      <button
        class="round"
        title="Lock vault"
        @click="lockVault"
      >
        ⌑
      </button>
    </header>

    <section
      v-if="!unlocked"
      class="locked card"
    >
      <span>⌑</span><h2>Vault locked</h2><p>Unlock Sulla with your master password to open the vault.</p>
    </section>

    <section
      v-else-if="screen === 'list'"
      class="vault-body"
    >
      <aside class="side card">
        <p class="label">
          VAULT
        </p>
        <button
          v-for="filter in filters"
          :key="filter.key"
          :class="['side-link', { active: activeFilter === filter.key }]"
          @click="activeFilter = filter.key"
        >
          <span>{{ filter.icon }}</span>{{ filter.label }}<b>{{ filter.count }}</b>
        </button>
        <p class="label section-label">
          FOLDERS
        </p>
        <button
          v-for="folder in folders"
          :key="folder.name"
          :class="['side-link', { active: activeFilter === `folder:${folder.name}` }]"
          @click="activeFilter = `folder:${folder.name}`"
        >
          <span>▰</span>{{ folder.name }}<b>{{ folder.count }}</b>
        </button>
      </aside>

      <section class="list-column">
        <div class="list-bar">
          <div class="segments">
            <button
              :class="{ on: activeFilter === 'all' }"
              @click="activeFilter = 'all'"
            >
              All <b>{{ items.length }}</b>
            </button><button
              :class="{ on: activeFilter === 'only_me' }"
              @click="activeFilter = 'only_me'"
            >
              ⌑ Only me <b>{{ onlyMeCount }}</b>
            </button><button
              :class="{ on: activeFilter === 'agents' }"
              @click="activeFilter = 'agents'"
            >
              ♙ Agents can use <b>{{ agentCount }}</b>
            </button>
          </div><span>Sort: Recently edited</span>
        </div>
        <div
          v-if="loading"
          class="empty"
        >
          Opening encrypted items…
        </div>
        <div
          v-else-if="!filteredItems.length"
          class="empty"
        >
          No vault items match this view.
        </div>
        <button
          v-for="(item, index) in filteredItems"
          :key="item.id"
          :class="['item-row', { selected: selected?.id === item.id }]"
          @click="selectItem(item)"
        >
          <span :class="['tile', `c${index % 5 + 1}`]">{{ typeIcon(item.plaintext.type) }}</span>
          <span class="item-meta"><strong>{{ item.plaintext.name }} <i v-if="item.plaintext.favorite">★</i></strong><small>{{ subtitle(item.plaintext) }}</small></span>
          <span
            v-if="item.plaintext.agentPolicy.mode === 'agents'"
            :class="['level', `l-${item.plaintext.agentPolicy.level}`]"
          >{{ item.plaintext.agentPolicy.level.toUpperCase() }}</span>
          <span :class="['badge', item.plaintext.agentPolicy.mode === 'agents' ? 'agents' : 'mine']">{{ item.plaintext.agentPolicy.mode === 'agents' ? '♙ Agents can use' : '⌑ Only me' }}</span>
        </button>
      </section>

      <aside
        v-if="selected"
        class="detail card"
      >
        <div class="detail-head">
          <span class="tile xl">{{ typeIcon(selected.plaintext.type) }}</span><div class="grow">
            <h2>{{ selected.plaintext.name }}</h2><small>{{ typeLabel(selected.plaintext.type) }} · edited {{ formatDate(selected.updated_at) }}</small>
          </div><button
            class="btn"
            @click="startEdit"
          >
            Edit
          </button><button
            class="icon"
            title="Delete"
            @click="deleteSelected"
          >
            ⋯
          </button>
        </div>
        <div class="fields">
          <div
            v-for="field in detailFields"
            :key="field.key"
            class="field"
          >
            <span class="field-key">{{ field.label }}</span><a
              v-if="field.link"
              class="field-value link"
              :href="field.link"
              target="_blank"
            >{{ field.value }}</a><span
              v-else
              :class="['field-value', { mono: field.secret || field.code }]"
            >{{ field.secret && !revealed.has(field.key) ? '••••••••••••••' : field.value }}</span><span
              v-if="field.code"
              class="countdown"
            >{{ totpLeft }}s</span><button
              v-if="field.secret"
              class="icon"
              @click="toggleReveal(field.key)"
            >
              {{ revealed.has(field.key) ? '◉' : '◌' }}
            </button><button
              class="icon"
              @click="copy(field.value)"
            >
              ▣
            </button>
          </div>
        </div>
        <div
          v-if="selected.plaintext.notes"
          class="notes"
        >
          <span class="label">NOTES</span><p>{{ selected.plaintext.notes }}</p>
        </div>
        <div
          class="access-card"
          :class="{ restricted: selected.plaintext.agentPolicy.mode === 'only_me' }"
        >
          <div class="access-title">
            <span class="agent-icon">♙</span><div class="grow">
              <strong>{{ selected.plaintext.agentPolicy.mode === 'agents' ? 'Agents can use this' : 'Only you can use this' }}</strong><small>{{ selected.plaintext.agentPolicy.mode === 'agents' ? 'Sulla can use it within the limits below.' : 'Agents cannot see or use this item.' }}</small>
            </div>
          </div><template v-if="selected.plaintext.agentPolicy.mode === 'agents'">
            <div class="ladder">
              <span
                v-for="level in levels"
                :key="level"
                :class="{ on: selected.plaintext.agentPolicy.level === level }"
              >{{ capitalize(level) }}</span>
            </div><div class="kv">
              <span>Which agents</span><b>{{ selected.plaintext.agentPolicy.agents.join(', ') || 'All my agents' }}</b>
            </div><div class="kv">
              <span>Only on</span><b>{{ selected.plaintext.agentPolicy.sites.join(', ') || 'Any website' }}</b>
            </div><div class="kv">
              <span>Expires</span><b>{{ selected.plaintext.agentPolicy.expiresAt ? formatDate(selected.plaintext.agentPolicy.expiresAt) : 'Never' }}</b>
            </div>
          </template>
        </div>
        <button
          class="audit-toggle"
          @click="showAudit = !showAudit"
        >
          Recent agent use <span>{{ showAudit ? 'Hide' : 'Show log' }} →</span>
        </button>
        <div
          v-if="showAudit"
          class="audit"
        >
          <div
            v-if="!audit.length"
            class="muted"
          >
            No agent use in this app session.
          </div><div
            v-for="event in audit"
            :key="event.id"
            class="audit-row"
          >
            <i :class="{ blocked: event.blocked }" /><span><b>{{ event.agentId }}</b> · {{ event.level }}<small>{{ formatDate(event.createdAt) }}<em v-if="event.blocked">Blocked: {{ event.reason }}</em></small></span>
          </div>
        </div>
        <details
          v-if="selected.plaintext.passwordHistory?.length"
          class="history"
        >
          <summary>{{ selected.plaintext.passwordHistory.length }} earlier passwords</summary><div
            v-for="(entry, index) in selected.plaintext.passwordHistory"
            :key="entry.changedAt"
            class="history-row"
          >
            <span>{{ formatDate(entry.changedAt) }}</span><code>{{ revealed.has(`history-${index}`) ? entry.password : '••••••••••' }}</code><button
              class="icon"
              @click="toggleReveal(`history-${index}`)"
            >
              ◌
            </button><button
              class="icon"
              @click="copy(entry.password)"
            >
              ▣
            </button>
          </div>
        </details>
      </aside>
    </section>

    <section
      v-else
      class="editor"
    >
      <div class="crumbs">
        Vault › {{ typeLabel(draft.type) }} › <b>{{ editing ? `Edit ${draft.name}` : 'New item' }}</b>
      </div>
      <header class="editor-head">
        <span class="tile xl">{{ typeIcon(draft.type) }}</span><div class="grow">
          <h2>{{ editing ? `Edit ${draft.name}` : 'New vault item' }}</h2><small>{{ typeLabel(draft.type) }} · in My vault</small>
        </div><button
          v-if="editing"
          class="btn danger"
          @click="deleteSelected"
        >
          Move to trash
        </button><button
          class="btn"
          @click="cancelEdit"
        >
          Cancel
        </button><button
          class="primary"
          :disabled="saving || !draft.name.trim()"
          @click="saveDraft"
        >
          ✓ {{ saving ? 'Saving…' : 'Save changes' }}
        </button>
      </header>
      <div class="editor-grid">
        <section class="form card">
          <p class="label">
            {{ typeLabel(draft.type).toUpperCase() }} DETAILS
          </p>
          <label>Name<input v-model="draft.name"></label>
          <label class="check"><input
            v-model="draft.favorite"
            type="checkbox"
          > Favorite</label>
          <template v-if="draft.type === 'login'">
            <label>Username<input v-model="draft.username"></label><label>Password<div class="input-action"><input
              v-model="draft.password"
              :type="editPasswordVisible ? 'text' : 'password'"
            ><button @click="editPasswordVisible = !editPasswordVisible">{{ editPasswordVisible ? 'Hide' : 'Reveal' }}</button><button @click="generatorOpen = true">◆ Generate</button></div></label><label>One-time code (TOTP)<input
              v-model="draft.totp"
              placeholder="Base32 secret or otpauth:// URI"
            ></label>
          </template>
          <template v-if="draft.type === 'apiKey'">
            <label>Key / token<div class="input-action"><input
              v-model="draft.password"
              :type="editPasswordVisible ? 'text' : 'password'"
            ><button @click="editPasswordVisible = !editPasswordVisible">Reveal</button><button @click="generatorOpen = true">◆ Generate</button></div></label>
          </template>
          <template v-if="draft.type === 'card'">
            <div class="two">
              <label>Cardholder<input v-model="draft.card!.holder"></label><label>Brand<input v-model="draft.card!.brand"></label>
            </div><label>Card number<input v-model="draft.card!.number"></label><div class="three">
              <label>Month<input v-model="draft.card!.expMonth"></label><label>Year<input v-model="draft.card!.expYear"></label><label>Security code<input v-model="draft.card!.code"></label>
            </div>
          </template>
          <template v-if="draft.type === 'identity'">
            <div class="two">
              <label>First name<input v-model="draft.identity!.firstName"></label><label>Last name<input v-model="draft.identity!.lastName"></label>
            </div><label>Email<input v-model="draft.identity!.email"></label><label>Phone<input v-model="draft.identity!.phone"></label><label>Address<input v-model="draft.identity!.address"></label>
          </template>
          <label v-if="draft.type !== 'note'">Websites<textarea
            v-model="uriText"
            rows="2"
            placeholder="One website per line"
          /></label>
          <label>Folder<input
            v-model="draft.folder"
            placeholder="Personal, Work…"
          ></label>
          <label>Notes<textarea
            v-model="draft.notes"
            rows="4"
          /></label>
          <div class="custom">
            <div class="custom-head">
              <span class="label">CUSTOM FIELDS</span><button
                class="text-btn"
                @click="addField"
              >
                ＋ Add field
              </button>
            </div><div
              v-for="(field, index) in draft.fields"
              :key="index"
              class="custom-row"
            >
              <input
                v-model="field.name"
                placeholder="Name"
              ><input
                v-model="field.value"
                :type="field.hidden ? 'password' : 'text'"
                placeholder="Value"
              ><label class="check"><input
                v-model="field.hidden"
                type="checkbox"
              >Hidden</label><button
                class="icon"
                @click="draft.fields!.splice(index, 1)"
              >
                ×
              </button>
            </div>
          </div>
        </section>

        <section class="access-editor card">
          <p class="eyebrow">
            WHO CAN USE THIS
          </p><h2>Only you, or your agents too?</h2><div class="choices">
            <button
              :class="{ chosen: draft.agentPolicy.mode === 'only_me' }"
              @click="draft.agentPolicy.mode = 'only_me'"
            >
              <b>⌑ Only me</b><span>Agents can't see or use it. The server stores only scrambled data.</span>
            </button><button
              :class="{ chosen: draft.agentPolicy.mode === 'agents' }"
              @click="draft.agentPolicy.mode = 'agents'"
            >
              <b>♙ Agents can use</b><span>Your agents can use it within the limits below. You still own it.</span>
            </button>
          </div>
          <div
            v-if="draft.agentPolicy.mode === 'agents'"
            class="policy"
          >
            <span class="label">HOW MUCH CAN AGENTS DO?</span><button
              v-for="level in levels"
              :key="level"
              :class="['policy-level', { chosen: draft.agentPolicy.level === level }]"
              @click="draft.agentPolicy.level = level"
            >
              <i /><b>{{ capitalize(level) }}<small>LEVEL {{ levels.indexOf(level) + 1 }}</small></b><span>{{ policyDescription[level] }}</span>
            </button><div class="limits">
              <label>Which agents<input
                v-model="agentText"
                placeholder="All my agents"
              ></label><label>Only on<input
                v-model="siteText"
                placeholder="Any website"
              ></label><label>Expires<input
                v-model="expiryText"
                type="datetime-local"
              ></label><label class="switch-line"><span><b>Ask me first</b><small>Approve every use</small></span><input
                v-model="draft.agentPolicy.askFirst"
                type="checkbox"
              ></label>
            </div><label class="server-line"><span><b>Also allow my server agents</b><small>Server agents may use this item under the same limits.</small></span><input
              v-model="draft.agentPolicy.allowServerAgents"
              type="checkbox"
            ></label>
          </div>
        </section>
      </div>
    </section>

    <div
      v-if="generatorOpen"
      class="modal"
      @click.self="generatorOpen = false"
    >
      <PasswordGenerator
        :show-use-button="true"
        @back="generatorOpen = false"
        @use-password="useGenerated"
      />
    </div>
    <div
      v-if="toast"
      class="toast"
    >
      {{ toast }}
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

import PasswordGenerator from './PasswordGenerator.vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { AgentPolicy, VaultItemPlaintext, VaultItemType } from '../../../packages/vault-crypto/src/itemSchema';

interface RemoteItem { id: string; revision: number; updated_at: string; created_at: string; plaintext: VaultItemPlaintext }
interface AuditEvent { id: string; itemId: string; agentId: string; level: string; blocked: boolean; reason?: string; createdAt: string }
interface DetailField { key: string; label: string; value: string; secret?: boolean; link?: string; code?: boolean }
type Draft = VaultItemPlaintext;
const levels: AgentPolicy['level'][] = ['metadata', 'autofill', 'full'];
const policyDescription = { metadata: 'See that this item exists, but never use its secret.', autofill: 'Sign in and call trusted tools without putting the secret in chat.', full: 'Read the actual value. It may reach the agent context.' };
const itemTypes:{ value: VaultItemType; label: string; icon: string }[] = [{ value: 'login', label: 'Login', icon: '◎' }, { value: 'note', label: 'Secure note', icon: '▤' }, { value: 'card', label: 'Card', icon: '▣' }, { value: 'identity', label: 'Identity', icon: '♧' }, { value: 'apiKey', label: 'API key', icon: '⚿' }];
const emptyPolicy = ():AgentPolicy => ({ mode: 'only_me', level: 'metadata', agents: [], sites: [], expiresAt: null, askFirst: false, allowServerAgents: false });
const emptyDraft = (type:VaultItemType = 'login'):Draft => ({ type, name: '', favorite: false, username: '', password: '', totp: '', uris: [], notes: '', fields: [], folder: '', card: {}, identity: {}, agentPolicy: emptyPolicy() });
const items = ref<RemoteItem[]>([]); const selected = ref<RemoteItem | null>(null); const unlocked = ref(false); const loading = ref(false); const saving = ref(false); const query = ref(''); const activeFilter = ref('all'); const screen = ref<'list' | 'editor'>('list'); const editing = ref(false); const newMenu = ref(false); const showAudit = ref(false); const audit = ref<AuditEvent[]>([]); const toast = ref(''); const generatorOpen = ref(false); const editPasswordVisible = ref(false); const agentText = ref(''); const siteText = ref(''); const uriText = ref(''); const expiryText = ref(''); const totpCode = ref(''); const totpLeft = ref(30);
const revealed = ref(new Set<string>()); const draft = reactive<Draft>(emptyDraft()); let ticker:number | undefined;
const filters = computed(() => [{ key: 'all', label: 'Everything', icon: '▦', count: items.value.length }, { key: 'favorites', label: 'Favorites', icon: '★', count: items.value.filter(i => i.plaintext.favorite).length }, ...itemTypes.map(t => ({ key: t.value, label: t.label + (t.value === 'login' ? 's' : ''), icon: t.icon, count: items.value.filter(i => i.plaintext.type === t.value).length }))]);
const folders = computed(() => { const map = new Map<string, number>(); items.value.forEach(i => { if (i.plaintext.folder)map.set(i.plaintext.folder, (map.get(i.plaintext.folder) || 0) + 1); }); return [...map].map(([name, count]) => ({ name, count })) });
const onlyMeCount = computed(() => items.value.filter(i => i.plaintext.agentPolicy.mode === 'only_me').length); const agentCount = computed(() => items.value.length - onlyMeCount.value);
const filteredItems = computed(() => items.value.filter(i => { const p = i.plaintext; const q = query.value.toLowerCase(); const text = `${ p.name } ${ p.username || '' } ${ p.uris?.map(u => u.uri).join(' ') || '' }`.toLowerCase(); const f = activeFilter.value; return (!q || text.includes(q)) && (f === 'all' || (f === 'favorites' && p.favorite) || (f === 'only_me' && p.agentPolicy.mode === 'only_me') || (f === 'agents' && p.agentPolicy.mode === 'agents') || (f.startsWith('folder:') && p.folder === f.slice(7)) || p.type === f) }));
const detailFields = computed<DetailField[]>(() => { if (!selected.value) return []; const p = selected.value.plaintext; const out:DetailField[] = []; if (p.username)out.push({ key: 'username', label: 'Username', value: p.username }); if (p.password)out.push({ key: 'password', label: p.type === 'apiKey' ? 'Key / token' : 'Password', value: p.password, secret: true }); if (p.totp)out.push({ key: 'totp', label: 'One-time', value: totpCode.value || '— — —', code: true }); p.uris?.forEach((u, i) => out.push({ key: `uri-${ i }`, label: i ? 'Website' : 'Website', value: u.uri, link: /^https?:/.test(u.uri) ? u.uri : `https://${ u.uri }` })); if (p.card) { [['holder', 'Cardholder'], ['brand', 'Brand'], ['number', 'Number'], ['expMonth', 'Exp. month'], ['expYear', 'Exp. year'], ['code', 'Security code']].forEach(([k, l]) => { const v = p.card?.[k as keyof typeof p.card]; if (v)out.push({ key: `card-${ k }`, label: l, value: v, secret: k === 'number' || k === 'code' }); }) } if (p.identity)Object.entries(p.identity).forEach(([k, v]) => v && out.push({ key: `identity-${ k }`, label: k.replace(/([A-Z])/g, ' $1'), value: v })); p.fields?.forEach((f, i) => f.value && out.push({ key: `custom-${ i }`, label: f.name, value: f.value, secret: f.hidden })); return out });

function typeIcon(t:VaultItemType) { return itemTypes.find(x => x.value === t)?.icon || '•' } function typeLabel(t:VaultItemType) { return itemTypes.find(x => x.value === t)?.label || t } function capitalize(v:string) { return v[0].toUpperCase() + v.slice(1) }
function subtitle(p:VaultItemPlaintext) { return [p.username, p.uris?.[0]?.uri, p.folder || typeLabel(p.type)].filter(Boolean).join(' · ') } function formatDate(v:string) { return new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: undefined }) }
async function loadItems(keepId?:string) { loading.value = true; try { unlocked.value = await ipcRenderer.invoke('vault:v2-is-unlocked' as any); if (!unlocked.value) { items.value = []; selected.value = null; return }items.value = await ipcRenderer.invoke('vault:v2-list' as any); selected.value = items.value.find(i => i.id === (keepId || selected.value?.id)) || items.value[0] || null; if (selected.value) await loadAudit(); } catch { unlocked.value = false } finally { loading.value = false } }
async function selectItem(item:RemoteItem) { selected.value = item; revealed.value = new Set(); showAudit.value = false; await Promise.all([loadAudit(), updateTotp()]) } async function loadAudit() { audit.value = selected.value ? await ipcRenderer.invoke('vault:v2-audit' as any, selected.value.id) : [] }
function assignDraft(value:Draft) { Object.assign(draft, emptyDraft(value.type), structuredClone(value)); draft.fields ??= []; draft.card ??= {}; draft.identity ??= {}; draft.agentPolicy = { ...emptyPolicy(), ...value.agentPolicy } }
function startCreate(type:VaultItemType) { newMenu.value = false; editing.value = false; assignDraft(emptyDraft(type)); agentText.value = ''; siteText.value = ''; uriText.value = ''; expiryText.value = ''; screen.value = 'editor' }
function startEdit() { if (!selected.value) return; editing.value = true; assignDraft(selected.value.plaintext); agentText.value = draft.agentPolicy.agents.join(', '); siteText.value = draft.agentPolicy.sites.join(', '); uriText.value = (draft.uris || []).map(u => u.uri).join('\n'); expiryText.value = draft.agentPolicy.expiresAt?.slice(0, 16) || ''; screen.value = 'editor' } function cancelEdit() { screen.value = 'list' } function addField() { draft.fields?.push({ name: '', value: '', hidden: false }) }
async function saveDraft() { if (!draft.name.trim()) return; saving.value = true; try { draft.uris = uriText.value.split(/\n|,/).map(v => v.trim()).filter(Boolean).map(uri => ({ uri, match: 'domain' })); draft.agentPolicy.agents = agentText.value.split(',').map(v => v.trim()).filter(Boolean); draft.agentPolicy.sites = siteText.value.split(',').map(v => v.trim().toLowerCase()).filter(Boolean); draft.agentPolicy.expiresAt = expiryText.value ? new Date(expiryText.value).toISOString() : null; draft.fields = draft.fields?.filter(f => f.name || f.value); if (editing.value && selected.value?.plaintext.password && draft.password !== selected.value.plaintext.password)draft.passwordHistory = [{ password: selected.value.plaintext.password, changedAt: new Date().toISOString() }, ...(selected.value.plaintext.passwordHistory || [])].slice(0, 20); const id = await ipcRenderer.invoke('vault:v2-save' as any, { id: editing.value ? selected.value?.id : undefined, revision: editing.value ? selected.value?.revision : undefined, plaintext: structuredClone(draft) }); screen.value = 'list'; await loadItems(id); flash('Saved securely') } finally { saving.value = false } }
async function deleteSelected() { if (!selected.value || !window.confirm(`Move “${ selected.value.plaintext.name }” to trash?`)) return; await ipcRenderer.invoke('vault:v2-delete' as any, { id: selected.value.id, revision: selected.value.revision }); screen.value = 'list'; selected.value = null; await loadItems(); flash('Moved to trash') }
async function lockVault() { await ipcRenderer.invoke('vault:lock-vault' as any); unlocked.value = false; items.value = []; selected.value = null } async function copy(value:string) { await navigator.clipboard.writeText(value); flash('Copied') } function toggleReveal(key:string) { const next = new Set(revealed.value); next.has(key) ? next.delete(key) : next.add(key); revealed.value = next } function flash(value:string) { toast.value = value; window.setTimeout(() => { if (toast.value === value)toast.value = ''; }, 1600) } function useGenerated(value:string) { draft.password = value; generatorOpen.value = false; editPasswordVisible.value = true }
function base32(input:string) { const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, ''); let bits = ''; for (const c of clean)bits += alphabet.indexOf(c).toString(2).padStart(5, '0'); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8)out.push(parseInt(bits.slice(i, i + 8), 2)); return new Uint8Array(out) }
async function updateTotp() { const raw = selected.value?.plaintext.totp; if (!raw) { totpCode.value = ''; return } try { let secret = raw; let period = 30; let digits = 6; if (raw.startsWith('otpauth://')) { const url = new URL(raw); secret = url.searchParams.get('secret') || ''; period = Number(url.searchParams.get('period') || 30); digits = Number(url.searchParams.get('digits') || 6) } const counter = Math.floor(Date.now() / 1000 / period); totpLeft.value = period - (Math.floor(Date.now() / 1000) % period); const msg = new Uint8Array(8); let n = counter; for (let i = 7; i >= 0; i--) { msg[i] = n & 255; n = Math.floor(n / 256) } const key = await crypto.subtle.importKey('raw', base32(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']); const hash = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg)); const off = hash[hash.length - 1] & 15; const code = (((hash[off] & 127) << 24) | ((hash[off + 1] & 255) << 16) | ((hash[off + 2] & 255) << 8) | (hash[off + 3] & 255)) % (10 ** digits); totpCode.value = String(code).padStart(digits, '0').replace(/(.{3})/, '$1 ') } catch { totpCode.value = 'Invalid TOTP' } }
onMounted(() => { loadItems().catch(() => undefined); ticker = window.setInterval(() => { updateTotp().catch(() => undefined) }, 1000); ipcRenderer.on('vault:logged-in' as any, () => { loadItems().catch(() => undefined) }) }); onBeforeUnmount(() => { if (ticker)window.clearInterval(ticker); });
</script>

<style scoped>
:global(body){background:#eef2f4}.vault-page{--ink:#172b38;--muted:#778995;--accent:#3a7fa0;--hair:#d8e1e6;min-height:100%;box-sizing:border-box;padding:26px 30px;color:var(--ink);background:radial-gradient(circle at 78% 0,#fff 0,transparent 32%),linear-gradient(135deg,#f7f9fa,#edf1f3);font-family:Inter,system-ui,sans-serif}.vault-head{display:flex;align-items:flex-end;gap:13px;padding-bottom:20px;margin-bottom:22px;border-bottom:1px solid var(--hair)}.head-copy{flex:1}.eyebrow,.label{color:#82919b;font:600 10px ui-monospace,monospace;letter-spacing:.12em}.head-copy h1{margin:5px 0 2px;font:600 28px Georgia,serif}.head-copy p{margin:0;color:var(--muted);font-size:13px}.status{padding:10px 13px;border:1px solid var(--hair);border-radius:20px;background:#fff;color:var(--muted);font-size:11px}.status i{display:inline-block;width:7px;height:7px;margin-right:6px;border-radius:50%;background:#3d9b76}.status i.off{background:#bd6a65}.search{display:flex;align-items:center;gap:8px;width:250px;height:40px;padding:0 11px;box-sizing:border-box;border:1px solid var(--hair);border-radius:10px;background:#fff;color:#8c9aa3}.search input{min-width:0;flex:1;border:0;outline:0;background:transparent}.search kbd{padding:2px 5px;border:1px solid var(--hair);border-radius:4px;font-size:9px}.primary,.btn,.round,.icon,.side-link,.segments button,.item-row,.menu button,.choices button,.policy-level,.text-btn,.audit-toggle{border:0;cursor:pointer}.primary{height:40px;padding:0 15px;border-radius:10px;background:var(--accent);color:white;font-weight:600}.primary:disabled{opacity:.5}.btn{padding:8px 12px;border-radius:8px;background:#e6f0f3;color:var(--accent)}.btn.danger,.danger{color:#a95d5a;background:#f6e9e8}.round{width:40px;height:40px;border:1px solid var(--hair);border-radius:50%;background:#fff}.new-wrap{position:relative}.menu{position:absolute;z-index:4;top:46px;right:0;width:180px;padding:7px;border:1px solid var(--hair);border-radius:11px;background:#fff;box-shadow:0 12px 30px #39505b22}.menu button{display:block;width:100%;padding:9px 10px;border-radius:7px;background:transparent;text-align:left}.menu button:hover{background:#edf5f7}.card{border:1px solid var(--hair);border-radius:15px;background:#ffffffc9;box-shadow:0 8px 24px #2741500a}.locked{padding:80px;text-align:center}.locked>span{font-size:40px}.locked h2{font:600 26px Georgia,serif}.locked p{color:var(--muted)}.vault-body{display:grid;grid-template-columns:210px minmax(420px,1fr) 390px;gap:18px;min-height:650px}.side{padding:15px 10px}.side .label{display:block;margin:5px 10px 9px}.section-label{margin-top:25px!important}.side-link{display:flex;align-items:center;gap:9px;width:100%;padding:9px 10px;border-radius:8px;background:transparent;color:#5e717d;text-align:left}.side-link:hover,.side-link.active{background:#e8f1f4;color:var(--ink)}.side-link span{width:17px}.side-link b{margin-left:auto;color:#95a3ab;font:500 10px ui-monospace,monospace}.list-bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;color:#8997a0;font-size:10px}.segments{display:flex;padding:3px;border-radius:18px;background:#e4eaed}.segments button{padding:7px 11px;border-radius:15px;background:transparent;color:#70818b;font-size:10px}.segments button.on{background:white;color:var(--ink);box-shadow:0 1px 4px #8798a244}.segments b{color:#9aa7ae}.item-row{display:flex;align-items:center;gap:11px;width:100%;min-height:66px;padding:10px 13px;margin-bottom:8px;border:1px solid #dce4e8;border-radius:13px;background:#ffffffae;text-align:left}.item-row:hover,.item-row.selected{border-color:#8db9c9;background:#edf6f8}.tile{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:38px;height:38px;border-radius:11px;background:#3b819e;color:#fff;font-size:18px}.tile.xl{width:48px;height:48px;border-radius:14px}.c2{background:#6e75b1}.c3{background:#4c9784}.c4{background:#b76f80}.c5{background:#b98558}.item-meta{flex:1;min-width:0}.item-meta strong,.item-meta small{display:block}.item-meta strong{font-size:13px}.item-meta strong i{color:var(--accent);font-style:normal}.item-meta small{overflow:hidden;margin-top:4px;color:#87959e;font:10px ui-monospace,monospace;text-overflow:ellipsis;white-space:nowrap}.level{width:64px;color:#7e8e97;font:600 9px ui-monospace,monospace}.l-autofill{color:var(--accent)}.l-full{color:#a55e67}.badge{white-space:nowrap;font-size:10px}.badge.agents{color:#337893}.badge.mine{color:#89969e}.detail{padding:19px;overflow:auto}.detail-head,.access-title,.editor-head{display:flex;align-items:center;gap:11px}.grow{flex:1;min-width:0}.detail h2,.editor h2{margin:0 0 3px;font:600 21px Georgia,serif}.detail small,.editor-head small{color:#87959e;font-size:10px}.icon{padding:5px;background:transparent;color:#677b86}.fields{display:flex;flex-direction:column;gap:7px;margin:19px 0}.field{display:flex;align-items:center;gap:7px;padding:10px;border:1px solid #e0e7ea;border-radius:9px;background:white}.field-key{width:76px;color:#87949c;font:600 9px ui-monospace,monospace;text-transform:uppercase}.field-value{flex:1;overflow:hidden;font-size:12px;text-overflow:ellipsis}.field-value.link{color:var(--accent);text-decoration:none}.mono{font-family:ui-monospace,monospace}.countdown{color:#93a0a8;font:9px ui-monospace,monospace}.notes{padding:12px;border:1px solid #e0e7ea;border-radius:9px;background:white}.notes p{margin:7px 0 0;color:#526772;font-size:12px;white-space:pre-wrap}.access-card{padding:14px;border:1px solid #aed0db;border-radius:13px;background:linear-gradient(145deg,#edf8fa,#f9fcfc)}.access-card.restricted{border-color:#dde4e7;background:#f7f9fa}.agent-icon{display:grid;width:32px;height:32px;place-items:center;border-radius:10px;background:#d5edf2;color:var(--accent)}.access-title strong,.access-title small{display:block}.access-title strong{font-size:13px}.ladder{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin:14px 0 10px}.ladder span{padding:7px;border:1px solid #d9e4e7;border-radius:7px;background:white;color:#819098;text-align:center;font-size:9px}.ladder span.on{border-color:var(--accent);background:var(--accent);color:white}.kv{display:flex;justify-content:space-between;gap:8px;padding:7px 0;border-top:1px solid #d7e5e8;color:#71838c;font-size:10px}.kv b{text-align:right;color:#526b77;font-weight:500}.audit-toggle{display:flex;justify-content:space-between;width:100%;padding:12px 0;background:transparent;color:#677b86;text-align:left}.audit-toggle span{color:var(--accent)}.audit{padding:12px 0;border-top:1px solid var(--hair)}.audit-row{display:flex;gap:8px;padding:6px 0;font-size:11px}.audit-row>i{width:7px;height:7px;margin-top:4px;border-radius:50%;background:#3b9a75}.audit-row>i.blocked{background:#c26460}.audit-row small,.audit-row em{display:block;margin-top:2px}.audit-row em{color:#b25d5a;font-style:normal}.muted{color:var(--muted);font-size:11px}.history{border-top:1px solid var(--hair);padding-top:10px;color:#667a85;font-size:11px}.history summary{cursor:pointer}.history-row{display:flex;align-items:center;gap:8px;padding:7px 0}.history-row code{flex:1}.empty{padding:50px;color:#82919a;text-align:center}.crumbs{margin-bottom:14px;color:#7c8c96;font-size:11px}.editor-head{padding-bottom:19px;border-bottom:1px solid var(--hair)}.editor-grid{display:grid;grid-template-columns:1fr 1.15fr;gap:20px;margin-top:20px}.form,.access-editor{padding:21px}.form>label,.limits>label{display:flex;flex-direction:column;gap:6px;margin-top:13px;color:#748690;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em}.form input,.form textarea,.limits input{width:100%;box-sizing:border-box;padding:10px 11px;border:1px solid #d9e3e7;border-radius:9px;outline:0;background:white;color:var(--ink);font:13px Inter,sans-serif;text-transform:none}.form input:focus,.form textarea:focus,.limits input:focus{border-color:#77aebe;box-shadow:0 0 0 3px #e5f1f4}.check{flex-direction:row!important;align-items:center;text-transform:none!important}.check input{width:auto}.two,.three{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.three{grid-template-columns:repeat(3,1fr)}.two label,.three label{display:flex;flex-direction:column;gap:6px;margin-top:13px;color:#748690;font-size:10px;font-weight:600;text-transform:uppercase}.input-action{display:flex;gap:6px}.input-action input{flex:1}.input-action button{border:0;border-radius:8px;background:#e6f0f3;color:var(--accent);font-size:10px}.custom{margin-top:20px}.custom-head{display:flex;justify-content:space-between}.text-btn{background:transparent;color:var(--accent)}.custom-row{display:grid;grid-template-columns:1fr 1.5fr auto auto;gap:7px;align-items:center;margin-top:8px}.access-editor h2{margin:6px 0 18px}.choices{display:grid;grid-template-columns:1fr 1fr;gap:10px}.choices button{padding:15px;border:1px solid var(--hair);border-radius:13px;background:white;text-align:left}.choices button.chosen,.policy-level.chosen{border-color:#75acbd;background:#edf7f9;box-shadow:0 0 0 3px #e2f0f3}.choices b,.choices span{display:block}.choices span{margin-top:6px;color:#748690;font-size:10px;line-height:1.5}.policy{margin-top:21px}.policy-level{display:grid;grid-template-columns:16px 110px 1fr;gap:9px;align-items:start;width:100%;padding:11px 12px;margin-top:8px;border:1px solid #dde5e8;border-radius:10px;background:white;text-align:left}.policy-level i{width:13px;height:13px;margin-top:2px;border:1px solid #9babb3;border-radius:50%}.policy-level.chosen i{border:4px solid var(--accent);box-sizing:border-box}.policy-level b{font-size:12px}.policy-level b small{display:block;margin-top:4px;color:var(--accent);font:8px ui-monospace,monospace}.policy-level>span{color:#70828c;font-size:10px;line-height:1.5}.limits{display:grid;grid-template-columns:1fr 1fr;gap:10px}.switch-line,.server-line{display:flex!important;flex-direction:row!important;align-items:center!important;justify-content:space-between;padding:11px;border:1px solid var(--hair);border-radius:10px;background:#fff}.switch-line span,.server-line span{display:block}.switch-line b,.switch-line small,.server-line b,.server-line small{display:block}.switch-line small,.server-line small{margin-top:3px;color:#82909a;font-size:9px}.switch-line input,.server-line input{width:auto;accent-color:var(--accent)}.server-line{margin-top:14px;font-size:11px}.modal{position:fixed;z-index:20;inset:0;display:grid;place-items:center;padding:30px;background:#17263099}.modal>*{width:min(720px,90vw);max-height:90vh;overflow:auto;border-radius:18px;background:#f4f7f8;box-shadow:0 24px 80px #0005}.toast{position:fixed;z-index:30;bottom:28px;left:50%;padding:10px 16px;border-radius:20px;background:#18303d;color:white;font-size:11px;transform:translateX(-50%)}@media(max-width:1150px){.vault-body{grid-template-columns:190px 1fr}.detail{grid-column:1/-1}.editor-grid{grid-template-columns:1fr}.head-copy{min-width:100%}.vault-head{flex-wrap:wrap}}
</style>
