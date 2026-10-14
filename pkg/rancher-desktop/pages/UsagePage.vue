<template>
  <main class="usage-page">
    <header class="usage-header">
      <div>
        <p class="eyebrow">Local telemetry</p>
        <h1>Usage</h1>
        <p class="lede">Tokens, cache efficiency, and subscription windows across every model provider Sulla runs.</p>
      </div>
      <div class="window-picker" aria-label="Usage window">
        <button
          v-for="option in windows"
          :key="option.hours"
          type="button"
          :class="{ active: selectedHours === option.hours }"
          @click="selectedHours = option.hours"
        >{{ option.label }}</button>
      </div>
    </header>

    <div v-if="loading && !summary" class="state-card">Loading local usage…</div>
    <div v-else-if="error && !summary" class="state-card error-state">
      <strong>Usage data couldn't be loaded.</strong>
      <span>{{ error }}</span>
      <button type="button" @click="load">Try again</button>
    </div>

    <template v-else-if="summary">
      <section class="hero-grid" aria-label="Usage totals">
        <article class="metric-card metric-primary">
          <span class="metric-label">Total tokens</span>
          <strong>{{ compact(summary.totals.totalTokens) }}</strong>
          <span>{{ number(summary.totals.inputTokens) }} input · {{ number(summary.totals.outputTokens) }} output</span>
        </article>
        <article class="metric-card">
          <span class="metric-label">Cache tokens</span>
          <strong>{{ compact(summary.totals.cacheReadTokens) }}</strong>
          <span>{{ percent(totalCacheHitRate) }} hit rate</span>
        </article>
        <article class="metric-card">
          <span class="metric-label">Cache savings</span>
          <strong>{{ money(summary.totals.cacheSavingsUsd) }}</strong>
          <span>Estimated API-equivalent savings</span>
        </article>
        <article class="metric-card">
          <span class="metric-label">Estimated API cost</span>
          <strong>{{ money(summary.totals.estimatedCostUsd) }}</strong>
          <span>Estimate only · not your bill</span>
        </article>
      </section>

      <section class="section-block">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Plan windows</p>
            <h2>Subscription limits</h2>
          </div>
          <span class="freshness">Latest CLI snapshots</span>
        </div>
        <div class="limit-grid">
          <article v-for="provider in limitProviders" :key="provider.id" class="limit-card">
            <div class="provider-title">
              <span class="provider-dot" :class="`provider-${provider.id}`" />
              <strong>{{ provider.label }}</strong>
            </div>
            <template v-if="summary.limits[provider.id]?.windows.length">
              <div v-for="window in summary.limits[provider.id]!.windows" :key="window.id" class="limit-row">
                <div class="limit-copy">
                  <span>{{ window.label }}</span>
                  <strong>{{ Math.round(window.usedPercent) }}%</strong>
                </div>
                <div class="meter"><span :style="{ width: `${Math.min(100, window.usedPercent)}%` }" /></div>
                <small>{{ window.resetsAt ? `Resets ${formatReset(window.resetsAt)}` : 'Reset time unavailable' }}</small>
              </div>
              <p class="captured">Updated {{ relativeTime(summary.limits[provider.id]!.capturedAt) }}</p>
            </template>
            <p v-else class="no-data">No limit data yet</p>
          </article>
        </div>
      </section>

      <section class="section-block chart-block">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Daily activity</p>
            <h2>Token trend</h2>
          </div>
          <span class="freshness">{{ selectedWindowLabel }}</span>
        </div>
        <div class="chart-wrap">
          <svg class="trend-chart" viewBox="0 0 900 260" preserveAspectRatio="none" role="img" aria-label="Daily token usage trend">
            <defs>
              <linearGradient id="usage-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="currentColor" stop-opacity=".28" />
                <stop offset="1" stop-color="currentColor" stop-opacity="0" />
              </linearGradient>
            </defs>
            <line v-for="line in 4" :key="line" x1="0" x2="900" :y1="line * 52" :y2="line * 52" class="grid-line" />
            <path v-if="chartPoints" :d="`${chartPoints.area}`" class="chart-area" />
            <path v-if="chartPoints" :d="chartPoints.line" class="chart-line" />
            <circle v-for="point in chartPoints?.dots ?? []" :key="point.date" :cx="point.x" :cy="point.y" r="4" class="chart-dot">
              <title>{{ point.date }}: {{ number(point.tokens) }} tokens</title>
            </circle>
          </svg>
          <div class="chart-labels">
            <span v-for="label in chartLabels" :key="label.date">{{ label.label }}</span>
          </div>
          <div v-if="summary.totals.totalTokens === 0" class="chart-empty">No token activity in this window</div>
        </div>
      </section>

      <section class="section-block">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Sources</p>
            <h2>Providers</h2>
          </div>
          <span class="freshness">API providers appear as usage is recorded</span>
        </div>
        <div class="provider-grid">
          <article v-for="provider in visibleProviders" :key="provider.id" class="provider-card">
            <div class="provider-title">
              <span class="provider-dot" :class="`provider-${provider.id}`" />
              <strong>{{ provider.label }}</strong>
            </div>
            <span class="provider-total">{{ compact(provider.totalTokens) }}</span>
            <span class="provider-meta">{{ provider.records }} runs · {{ money(provider.estimatedCostUsd) }} est.</span>
          </article>
        </div>
      </section>

      <section class="section-block models-block">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Efficiency</p>
            <h2>By model</h2>
          </div>
        </div>
        <div class="model-table-wrap">
          <table>
            <thead>
              <tr><th>Model</th><th>Tokens</th><th>Input / output</th><th>Cache hit</th><th>Est. cost / 1M</th></tr>
            </thead>
            <tbody>
              <tr v-for="model in summary.models" :key="`${model.providerId}:${model.model}`">
                <td><strong>{{ model.model }}</strong><span>{{ model.providerLabel }}</span></td>
                <td>{{ number(model.totalTokens) }}</td>
                <td>{{ compact(model.inputTokens) }} / {{ compact(model.outputTokens) }}</td>
                <td>{{ percent(model.cacheHitRate) }}</td>
                <td>{{ model.estimatedCostPerMillionTokens === null ? 'Unpriced' : money(model.estimatedCostPerMillionTokens) }}</td>
              </tr>
              <tr v-if="summary.models.length === 0"><td colspan="5" class="empty-row">No model usage recorded in this window.</td></tr>
            </tbody>
          </table>
        </div>
        <p class="estimate-note">Cost and cache-savings figures use public API-equivalent token rates where Sulla recognizes the model. They are estimates, not subscription charges or an invoice.</p>
      </section>
    </template>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import type { UsageSummary } from '@pkg/agent/usage/providerUsage';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const windows = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
  { label: '30d', hours: 24 * 30 },
] as const;
const selectedHours = ref<number>(24 * 7);
const summary = ref<UsageSummary | null>(null);
const loading = ref(false);
const error = ref('');

const selectedWindowLabel = computed(() => windows.find(window => window.hours === selectedHours.value)?.label ?? '');
const limitProviders = computed(() => summary.value?.providers.filter(provider => provider.id === 'claude-code' || provider.id === 'codex') ?? []);
const visibleProviders = computed(() => summary.value?.providers.filter(provider => provider.records > 0 || ['claude-code', 'codex', 'grok'].includes(provider.id)) ?? []);
const totalCacheHitRate = computed(() => {
  if (!summary.value) return 0;
  const denominator = summary.value.totals.inputTokens + summary.value.totals.cacheReadTokens;
  return denominator > 0 ? summary.value.totals.cacheReadTokens / denominator : 0;
});

const chartPoints = computed(() => {
  const daily = summary.value?.daily ?? [];
  if (daily.length === 0) return null;
  const max = Math.max(1, ...daily.map(day => day.totalTokens));
  const dots = daily.map((day, index) => ({
    date: day.date,
    tokens: day.totalTokens,
    x: daily.length === 1 ? 450 : index / (daily.length - 1) * 900,
    y: 232 - day.totalTokens / max * 210,
  }));
  const line = dots.map((point, index) => `${ index ? 'L' : 'M' } ${ point.x.toFixed(1) } ${ point.y.toFixed(1) }`).join(' ');
  return { dots, line, area: `${ line } L 900 250 L 0 250 Z` };
});

const chartLabels = computed(() => {
  const daily = summary.value?.daily ?? [];
  if (daily.length === 0) return [];
  const indexes = [...new Set([0, Math.floor((daily.length - 1) / 2), daily.length - 1])];
  return indexes.map(index => ({ date: daily[index].date, label: new Date(`${ daily[index].date }T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }));
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    summary.value = await ipcRenderer.invoke('usage:summary', { hours: selectedHours.value });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function compact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}
function number(value: number): string { return new Intl.NumberFormat().format(Math.round(value)) }
function money(value: number): string { return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: value < 1 ? 2 : 2, maximumFractionDigits: value < 1 ? 4 : 2 }).format(value) }
function percent(value: number): string { return `${ (value * 100).toFixed(value > 0 && value < 0.01 ? 1 : 0) }%` }
function formatReset(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : value;
}
function relativeTime(value: string): string {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed)) return value;
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) return `${ Math.floor(elapsed / 60_000) }m ago`;
  if (elapsed < 86_400_000) return `${ Math.floor(elapsed / 3_600_000) }h ago`;
  return new Date(value).toLocaleDateString();
}

watch(selectedHours, load);
onMounted(load);
</script>

<style scoped>
.usage-page { --usage-accent: var(--steel-400, #5096b3); min-height: 100%; padding: 44px clamp(24px, 5vw, 72px) 72px; background: var(--bg-page); color: var(--text-primary); overflow: auto; }
.usage-header, .section-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; }
.usage-header { margin: 0 auto 28px; max-width: 1280px; }
h1, h2, p { margin: 0; }
h1 { font-family: var(--serif); font-size: clamp(36px, 5vw, 58px); line-height: 1; letter-spacing: -.035em; }
h2 { font-family: var(--serif); font-size: 25px; letter-spacing: -.02em; }
.eyebrow, .metric-label { color: var(--usage-accent); font-family: var(--mono); font-size: 10px; letter-spacing: .2em; text-transform: uppercase; }
.lede { max-width: 660px; margin-top: 12px; color: var(--text-muted); font-family: var(--serif); font-size: 15px; }
.window-picker { display: inline-flex; padding: 4px; border: 1px solid var(--border-default); border-radius: 10px; background: var(--bg-surface); }
.window-picker button { min-width: 54px; padding: 8px 12px; border: 0; border-radius: 7px; color: var(--text-muted); background: transparent; font: 11px var(--mono); cursor: pointer; }
.window-picker button.active { color: var(--text-primary); background: color-mix(in srgb, var(--usage-accent) 18%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--usage-accent) 38%, transparent); }
.hero-grid, .section-block { max-width: 1280px; margin-left: auto; margin-right: auto; }
.hero-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.metric-card, .limit-card, .provider-card, .section-block, .state-card { border: 1px solid var(--border-default); background: var(--bg-surface); box-shadow: 0 18px 50px color-mix(in srgb, black 10%, transparent); }
.metric-card { min-height: 148px; padding: 20px; border-radius: 14px; display: flex; flex-direction: column; }
.metric-card.metric-primary { background: linear-gradient(145deg, color-mix(in srgb, var(--usage-accent) 14%, var(--bg-surface)), var(--bg-surface)); border-color: color-mix(in srgb, var(--usage-accent) 38%, var(--border-default)); }
.metric-card strong { margin: auto 0 6px; font-family: var(--serif); font-size: 31px; letter-spacing: -.025em; }
.metric-card > span:last-child, .provider-meta, .freshness, .captured, .no-data, .estimate-note { color: var(--text-muted); font: 11px/1.5 var(--mono); }
.section-block { padding: 24px; margin-top: 16px; border-radius: 16px; }
.section-heading { align-items: center; margin-bottom: 20px; }
.section-heading .eyebrow { margin-bottom: 6px; }
.limit-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.limit-card { padding: 18px; border-radius: 12px; box-shadow: none; }
.provider-title { display: flex; align-items: center; gap: 9px; font: 13px var(--mono); }
.provider-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--usage-accent); box-shadow: 0 0 12px color-mix(in srgb, var(--usage-accent) 70%, transparent); }
.provider-codex { background: #9aa7b5; }.provider-grok { background: #cb8cff; }.provider-claude-code { background: #df8f65; }
.limit-row { margin-top: 18px; }.limit-copy { display: flex; justify-content: space-between; font: 12px var(--mono); }.limit-copy span { color: var(--text-muted); }.limit-copy strong { color: var(--text-primary); }
.meter { height: 7px; margin: 8px 0 6px; overflow: hidden; border-radius: 999px; background: color-mix(in srgb, var(--text-muted) 16%, transparent); }.meter span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--usage-accent), color-mix(in srgb, var(--usage-accent) 55%, #fff)); }
.limit-row small { color: var(--text-muted); font: 10px var(--mono); }.captured { margin-top: 14px; }.no-data { padding: 28px 0 10px; }
.chart-wrap { position: relative; height: 285px; }.trend-chart { width: 100%; height: 245px; overflow: visible; color: var(--usage-accent); }.grid-line { stroke: color-mix(in srgb, var(--text-muted) 15%, transparent); stroke-width: 1; vector-effect: non-scaling-stroke; }.chart-area { fill: url(#usage-area); }.chart-line { fill: none; stroke: currentColor; stroke-width: 2.5; vector-effect: non-scaling-stroke; }.chart-dot { fill: var(--bg-surface); stroke: currentColor; stroke-width: 2.5; vector-effect: non-scaling-stroke; }.chart-labels { display: flex; justify-content: space-between; color: var(--text-muted); font: 10px var(--mono); }.chart-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--text-muted); font: 12px var(--mono); }
.provider-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }.provider-card { padding: 16px; border-radius: 11px; box-shadow: none; display: grid; gap: 10px; }.provider-total { font-family: var(--serif); font-size: 24px; }.provider-meta { font-size: 10px; }
.model-table-wrap { overflow-x: auto; }table { width: 100%; border-collapse: collapse; }th { padding: 10px 12px; color: var(--text-muted); border-bottom: 1px solid var(--border-default); text-align: right; font: 9px var(--mono); letter-spacing: .13em; text-transform: uppercase; }th:first-child, td:first-child { text-align: left; }td { padding: 14px 12px; border-bottom: 1px solid color-mix(in srgb, var(--border-default) 68%, transparent); text-align: right; white-space: nowrap; font: 12px var(--mono); }td:first-child strong, td:first-child span { display: block; }td:first-child span { margin-top: 4px; color: var(--text-muted); font-size: 10px; }.empty-row { padding: 32px; color: var(--text-muted); text-align: center !important; }.estimate-note { margin-top: 16px; max-width: 780px; }
.state-card { max-width: 1280px; margin: 0 auto; padding: 40px; border-radius: 14px; color: var(--text-muted); font: 13px var(--mono); }.error-state { display: grid; gap: 10px; color: var(--text-primary); }.error-state span { color: var(--text-muted); }.error-state button { width: max-content; padding: 8px 12px; border: 1px solid var(--border-default); border-radius: 7px; background: transparent; color: var(--text-primary); cursor: pointer; }
@media (max-width: 900px) { .hero-grid { grid-template-columns: repeat(2, 1fr); }.limit-grid { grid-template-columns: 1fr; } }
@media (max-width: 600px) { .usage-page { padding: 28px 16px 56px; }.usage-header { align-items: flex-start; flex-direction: column; }.hero-grid { grid-template-columns: 1fr; }.section-block { padding: 18px; }.freshness { display: none; } }
</style>
