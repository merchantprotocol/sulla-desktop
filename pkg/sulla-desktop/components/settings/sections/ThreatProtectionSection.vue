<!-- Sulla Desktop · https://sulladesktop.com
     Copyright (c) 2025-2026 Merchant Protocol LLC.
     SPDX-License-Identifier: GPL-2.0-or-later -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import PrefCard from '../PrefCard.vue';
import PrefRow from '../PrefRow.vue';
import PrefToggle from '../PrefToggle.vue';
import PrefMore from '../PrefMore.vue';
import {
  useThreatProtection,
  validThreatHost,
  type ThreatSettings,
} from '@pkg/composables/preferences/useThreatProtection';
import { openMainTab } from '@pkg/composables/preferences/openInMain';
import { ThreatProtectionLogic } from '@pkg/composables/preferences/threatProtectionLogic';

const logic = new ThreatProtectionLogic();
const t = useThreatProtection();
const newHost = ref('');
const root = ref<HTMLElement>();
const logCard = ref<HTMLElement>();
const hosts = computed(() => logic.allowlist(t.settings.value.allowlist));

const labels: Record<string, string> = {
  running:        'Running',
  'failing-open': 'Failing open',
  off:            'Off',
  starting:       'Starting',
  standby:        'Standing by',
};
const statusLabel = computed(() => labels[String(t.status.value.state)] ?? 'Standing by');
const neutralStatus = computed(() => {
  return !['running', 'failing-open', 'starting'].includes(String(t.status.value.state));
});

const verdicts: Record<string, string> = {
  allowed:     'Allowed',
  blocked:     'Blocked',
  warned:      'Warned',
  injection:   'Injection flagged',
  failed_open: 'Failed open',
};
const retentionOptions = [
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 360, label: '6 hours' },
  { value: 1440, label: '24 hours' },
];

const last24 = computed(() => logic.countLast24Hours(t.summaryEntries.value, Date.now()));
const summary = computed(() => {
  const failCount = t.status.value.failOpenTransitions24h ?? 0;
  const parts = [];

  if (t.settings.value.trafficLogEnabled) {
    parts.push(`${ last24.value.blocked } blocked URLs`, `${ last24.value.injection } injection warnings`);
  }
  parts.push(`${ failCount } fail-open ${ failCount === 1 ? 'event' : 'events' }`);

  return `Last 24 hours · ${ parts.join(' · ') }`;
});
const failingSince = computed(() => {
  const since = t.status.value.since;

  return since ? new Date(since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'unknown';
});

function inputValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLSelectElement).value;
}
function updateHosts(values: string[]) {
  void t.save({ allowlist: values.join(',') });
}
function addHost() {
  const host = newHost.value.trim().toLowerCase();

  if (!validThreatHost(host) || hosts.value.includes(host)) return;
  updateHosts([...hosts.value, host]);
  newHost.value = '';
}
function removeHost(host: string) {
  updateHosts(hosts.value.filter(value => value !== host));
}
function setMb(key: 'scanMaxBytes' | 'scanBufferMaxBytes', value: string) {
  void t.save({ [key]: logic.megabytesToBytes(Number(value)) });
}
function setNumber(key: 'bufferBudgetMb' | 'memoryPressurePercent', value: string) {
  void t.save({ [key]: Number(value) } as Pick<ThreatSettings, typeof key>);
}
function setMode(key: 'blockMode' | 'injectionMode', value: string) {
  void t.save({ [key]: value } as Pick<ThreatSettings, typeof key>);
}
function setRetention(value: string) {
  void t.setLog({ trafficLogRetentionMinutes: Number(value) });
}
function entryTime(ts: string | number): string {
  return new Date(ts).toLocaleTimeString();
}
function entrySize(entry: { bytes?: number, size?: string }): string {
  return typeof entry.bytes === 'number' ? logic.formatBytes(entry.bytes) : entry.size ?? '—';
}
function showLogs() {
  const card = logCard.value;

  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!t.settings.value.trafficLogEnabled) void t.setLog({ trafficLogEnabled: true });
}
async function clear() {
  if (window.confirm('Clear the traffic log? This cannot be undone.')) await t.clearLog();
}

let observer: IntersectionObserver | undefined;

onMounted(() => {
  observer = new IntersectionObserver(([entry]) => t.setVisible(entry.isIntersecting));
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div
    ref="root"
    class="sulla-prefs"
  >
    <div class="ph">
      <div>
        <h1>Threat Protection</h1>
        <p>Checks the web traffic your agents send and receive.</p>
      </div>
    </div>

    <PrefCard title="Protection">
      <template #actions>
        <span class="k">
          <span
            class="dot"
            :class="{ warn: t.status.value.state === 'failing-open', off: neutralStatus }"
          />
          {{ statusLabel }}
        </span>
      </template>
      <div
        v-if="t.status.value.state === 'failing-open'"
        class="alert warn"
      >
        <span
          class="pi"
          aria-hidden="true"
        >!</span>
        <div class="x">
          <b>Failing open</b>
          <span>{{ t.status.value.reason || 'Proxy restarting' }} — traffic going direct since {{ failingSince }}</span>
        </div>
        <div class="r">
          <button
            type="button"
            class="btn sm"
            @click="showLogs"
          >
            Show logs
          </button>
        </div>
      </div>
      <PrefRow
        title="Threat Protection"
        subtitle="Inspects agent web traffic for malicious URLs and prompt injection. When off, agent traffic goes direct."
      >
        <PrefToggle
          :model-value="t.settings.value.enabled"
          label="Threat Protection"
          @update:model-value="t.save({ enabled: $event })"
        />
      </PrefRow>
      <PrefRow
        title="If protection is unavailable"
        subtitle="Agents keep working while it restarts."
      >
        <span class="muted">Agent traffic goes direct (fail open)</span>
      </PrefRow>
      <p class="note">
        {{ summary }}
      </p>
    </PrefCard>

    <PrefCard
      title="What to check"
      :off="!t.settings.value.enabled"
    >
      <PrefRow title="Malicious URL blocking">
        <div class="seg">
          <button
            type="button"
            :class="{ on: t.settings.value.blockMode === 'block' }"
            @click="setMode('blockMode', 'block')"
          >
            Block
          </button>
          <button
            type="button"
            :class="{ on: t.settings.value.blockMode === 'warn' }"
            @click="setMode('blockMode', 'warn')"
          >
            Warn only
          </button>
          <button
            type="button"
            :class="{ on: t.settings.value.blockMode === 'off' }"
            @click="setMode('blockMode', 'off')"
          >
            Off
          </button>
        </div>
      </PrefRow>
      <PrefRow title="Prompt-injection scanning">
        <div class="seg">
          <button
            type="button"
            :class="{ on: t.settings.value.injectionMode === 'warn' }"
            @click="setMode('injectionMode', 'warn')"
          >
            Warn
          </button>
          <button
            type="button"
            :class="{ on: t.settings.value.injectionMode === 'redact' }"
            @click="setMode('injectionMode', 'redact')"
          >
            Redact
          </button>
          <button
            type="button"
            :class="{ on: t.settings.value.injectionMode === 'off' }"
            @click="setMode('injectionMode', 'off')"
          >
            Off
          </button>
        </div>
      </PrefRow>
      <PrefMore label="Advanced">
        <PrefRow
          title="Max inspected body size"
          subtitle="Larger pages and downloads pass through without a scan."
        >
          <input
            class="inp sm"
            type="number"
            :value="t.settings.value.scanMaxBytes / 1048576"
            aria-label="Max inspected body size in MB"
            @change="setMb('scanMaxBytes', inputValue($event))"
          >
          <span class="dimc">MB</span>
        </PrefRow>
        <PrefRow
          title="Buffer budget"
          subtitle="Most memory used to hold pages while they’re being scanned."
        >
          <input
            class="inp sm"
            type="number"
            :value="t.settings.value.bufferBudgetMb"
            aria-label="Buffer budget in MB"
            @change="setNumber('bufferBudgetMb', inputValue($event))"
          >
          <span class="dimc">MB</span>
        </PrefRow>
        <PrefRow
          title="Memory guard threshold"
          subtitle="Above this memory use, scanning pauses and traffic goes direct."
        >
          <input
            class="inp sm"
            type="number"
            :value="t.settings.value.memoryPressurePercent"
            aria-label="Memory guard threshold in percent"
            @change="setNumber('memoryPressurePercent', inputValue($event))"
          >
          <span class="dimc">%</span>
        </PrefRow>
      </PrefMore>
    </PrefCard>

    <PrefCard
      title="Allowlist"
      subtitle="These hosts skip inspection. Local and private addresses always skip it."
      :off="!t.settings.value.enabled"
    >
      <PrefRow layout="col">
        <div class="lst">
          <div
            v-for="host in hosts"
            :key="host"
          >
            <code class="mono">{{ host }}</code>
            <span class="r">
              <button
                type="button"
                class="btn sm ghost"
                @click="removeHost(host)"
              >
                Remove
              </button>
            </span>
          </div>
          <div
            v-if="!hosts.length"
            class="empty-row"
          >
            No hosts. Everything is inspected.
          </div>
          <div>
            <input
              v-model="newHost"
              class="inp wide mono"
              placeholder="example.com"
              aria-label="Host to allow"
              @keydown.enter="addHost"
            >
            <span class="r">
              <button
                type="button"
                class="btn sm"
                :disabled="!validThreatHost(newHost)"
                @click="addHost"
              >
                Add
              </button>
            </span>
          </div>
        </div>
      </PrefRow>
    </PrefCard>

    <PrefCard
      title="Reputation services"
      subtitle="Extra link checks. Their keys are kept in Integrations."
    >
      <template #actions>
        <button
          type="button"
          class="link"
          @click="openMainTab('integrations')"
        >
          Manage in Integrations
        </button>
      </template>
      <PrefRow
        title="Google Safe Browsing"
        subtitle="Google’s list of unsafe sites."
      >
        <span class="k">
          <span
            class="dot"
            :class="{ off: !t.keyStatus.value.safeBrowsing }"
          />
          {{ t.keyStatus.value.safeBrowsing ? 'Connected' : 'Not connected' }}
        </span>
      </PrefRow>
      <PrefRow
        title="VirusTotal"
        subtitle="Link scans from many security vendors."
      >
        <span class="k">
          <span
            class="dot"
            :class="{ off: !t.keyStatus.value.virusTotal }"
          />
          {{ t.keyStatus.value.virusTotal ? 'Connected' : 'Not connected' }}
        </span>
      </PrefRow>
    </PrefCard>

    <div ref="logCard">
      <PrefCard
        title="Traffic log"
        subtitle="Metadata only: never bodies, cookies, credentials or query values."
      >
        <template #actions>
          <button
            type="button"
            class="btn sm"
            @click="clear"
          >
            Clear log
          </button>
        </template>
        <PrefRow
          title="Record traffic log"
          subtitle="Off by default. Nothing is recorded while it’s off."
        >
          <PrefToggle
            :model-value="t.settings.value.trafficLogEnabled"
            label="Record traffic log"
            @update:model-value="t.setLog({ trafficLogEnabled: $event })"
          />
        </PrefRow>
        <PrefRow
          title="Keep entries for"
          subtitle="Stored on this Mac with a size cap. Old entries are deleted automatically."
        >
          <select
            class="sel"
            :value="t.settings.value.trafficLogRetentionMinutes"
            aria-label="Keep entries for"
            @change="setRetention(inputValue($event))"
          >
            <option
              v-for="option in retentionOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </PrefRow>
        <PrefRow layout="col">
          <div class="mk-tools">
            <input
              v-model="t.search.value"
              class="inp"
              type="search"
              placeholder="Search host, path or agent"
              aria-label="Search traffic log"
              @input="t.refreshLog()"
            >
            <select
              v-model="t.verdict.value"
              class="sel"
              aria-label="Filter by verdict"
              @change="t.refreshLog()"
            >
              <option value="">
                All verdicts
              </option>
              <option
                v-for="(label, key) in verdicts"
                :key="key"
                :value="key"
              >
                {{ label }}
              </option>
            </select>
          </div>
          <div class="lst mk-log">
            <div class="mk-h">
              <span>Time</span>
              <span>Agent / container</span>
              <span>Method</span>
              <span>Host + path</span>
              <span class="mk-num">Status</span>
              <span class="mk-num">Size</span>
              <span>Verdict</span>
            </div>
            <div
              v-if="!t.settings.value.trafficLogEnabled"
              class="empty-row"
            >
              Traffic logging is off. Turn on Record traffic log to see agent requests here.
            </div>
            <template v-else>
              <div
                v-for="(entry, index) in t.entries.value"
                :key="index"
              >
                <span class="mono dimc">{{ entryTime(entry.ts) }}</span>
                <span class="mk-path">{{ entry.agent || entry.container || '—' }}</span>
                <span class="mono">{{ entry.method }}</span>
                <span
                  class="mono mk-path"
                  :title="entry.host + entry.path"
                >{{ entry.host }}{{ entry.path }}</span>
                <span class="mono mk-num">{{ entry.status || '—' }}</span>
                <span class="mk-num dimc">{{ entrySize(entry) }}</span>
                <span
                  class="mk-v"
                  :class="entry.verdict"
                >{{ verdicts[entry.verdict] || entry.verdict }}</span>
              </div>
              <div
                v-if="!t.entries.value.length"
                class="empty-row"
              >
                No traffic recorded yet.
              </div>
            </template>
          </div>
        </PrefRow>
      </PrefCard>
    </div>
  </div>
</template>

<style scoped>
.ph { margin-bottom: 22px; }
.mk-tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.mk-tools .inp { flex: 1; min-width: 160px; width: auto; }
.mk-tools .sel { min-width: 160px; }
.mk-log { overflow-x: auto; }
.mk-log > div {
  display: grid;
  grid-template-columns: 62px 128px 52px minmax(160px, 1fr) 44px 58px 118px;
  gap: 10px;
  padding: 7px 12px;
  font-size: 12px;
  align-items: center;
  min-width: 690px;
}
.mk-log > div.mk-h {
  color: var(--dim);
  font-size: 11px;
  font-weight: 600;
  background: color-mix(in srgb, var(--paper-2) 55%, transparent);
}
.mk-log .mono { font-size: 11.5px; }
.mk-log .mk-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mk-log .mk-num { text-align: right; }
.mk-v {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  justify-self: start;
}
.mk-v.allowed { background: var(--ok-soft); color: var(--ok); }
.mk-v.blocked { background: var(--bad-soft); color: var(--bad); }
.mk-v.warned { background: var(--warn-soft); color: var(--warn); }
.mk-v.injection { background: var(--accent-soft); color: var(--accent-2); }
.mk-v.failed_open { background: var(--idle-soft); color: var(--muted); }
</style>
