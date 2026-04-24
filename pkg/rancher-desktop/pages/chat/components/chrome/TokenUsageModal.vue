<!--
  TokenUsageModal — summary of token + cost usage for the current
  session. Opened via ⌘I (info) or the `/tokens` command; closed on
  Esc / backdrop click.

  Reads from `controller.usage`, which is kept live by PersonaAdapter's
  watcher on the backend persona state.
-->
<template>
  <Transition name="veil">
    <div v-if="open" class="modal-veil" @click.self="controller.closeModal()">
      <div class="modal">
        <div class="mhead">
          <span>Token usage · ⌘I</span>
          <button class="x" type="button" @click="controller.closeModal()">✕</button>
        </div>

        <div class="mbody">
          <!-- Hero row: total tokens + cost -->
          <div class="hero">
            <div class="stat big">
              <div class="num">{{ fmtNumber(u.totalTokens) }}</div>
              <div class="lbl">Total tokens</div>
            </div>
            <div class="stat big">
              <div class="num">${{ u.totalCost.toFixed(4) }}</div>
              <div class="lbl">Total cost</div>
            </div>
          </div>

          <!-- Breakdown -->
          <div class="sec-label">Breakdown</div>
          <div class="grid">
            <div class="stat">
              <div class="num">{{ fmtNumber(u.promptTokens) }}</div>
              <div class="lbl">Prompt tokens</div>
              <div class="sub">${{ u.inputCost.toFixed(4) }} in</div>
            </div>
            <div class="stat">
              <div class="num">{{ fmtNumber(u.completionTokens) }}</div>
              <div class="lbl">Completion tokens</div>
              <div class="sub">${{ u.outputCost.toFixed(4) }} out</div>
            </div>
            <div class="stat">
              <div class="num">{{ u.responseCount }}</div>
              <div class="lbl">Responses</div>
              <div class="sub" v-if="u.avgResponseMs">avg {{ (u.avgResponseMs / 1000).toFixed(1) }}s</div>
              <div class="sub" v-else>—</div>
            </div>
            <div class="stat">
              <div class="num">{{ fmtNumber(Math.round(u.tokensPerSecond)) }}</div>
              <div class="lbl">Tokens/sec</div>
              <div class="sub">throughput</div>
            </div>
          </div>

          <!-- Model + context row -->
          <div class="sec-label">Session</div>
          <div class="session-row">
            <div class="sr-item">
              <span class="sr-lbl">Model</span>
              <span class="sr-val">{{ controller.model.value.name }}</span>
            </div>
            <div class="sr-item">
              <span class="sr-lbl">Context window</span>
              <span class="sr-val">{{ controller.model.value.ctx || '—' }}</span>
            </div>
            <div class="sr-item">
              <span class="sr-lbl">Connection</span>
              <span class="sr-val" :class="controller.connection.value">{{ connectionLabel }}</span>
            </div>
          </div>

          <p class="foot-note">
            Totals are lifetime for this persona — they accumulate across sessions
            as long as the tab stays connected. Costs are estimated from the active
            model's pricing.
          </p>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useChatController } from '../../controller/useChatController';

const controller = useChatController();
const open = computed(() => controller.modals.value.which === 'tokens');
const u    = computed(() => controller.usage.value);

const connectionLabel = computed(() => {
  const s = controller.connection.value;
  if (s === 'online')   return 'Online';
  if (s === 'degraded') return 'Starting up…';
  return 'Offline';
});

function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1000)   return String(Math.round(n));
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1_000_000).toFixed(2) + 'M';
}
</script>

<style scoped>
.modal-veil {
  position: absolute; inset: 0; z-index: 80;
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 12vh;
  background: rgba(7, 13, 26, 0.7); backdrop-filter: blur(8px);
}
.modal {
  width: 560px; max-width: calc(100vw - 48px);
  background: rgba(20, 30, 42, 0.96);
  border: 1px solid rgba(80, 150, 179, 0.3);
  border-radius: 12px; overflow: hidden;
  box-shadow: 0 30px 60px rgba(0,0,0,0.6);
}
.mhead {
  padding: 12px 18px;
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.28em;
  text-transform: uppercase; color: var(--steel-400);
  border-bottom: 1px solid rgba(80, 150, 179, 0.15);
  display: flex; align-items: center; gap: 12px;
}
.mhead .x {
  margin-left: auto; background: transparent; border: none;
  color: var(--read-4); cursor: pointer; font-size: 14px;
}
.mbody { padding: 22px 24px; }

.hero {
  display: grid; grid-template-columns: 1fr 1fr; gap: 16px;
  margin-bottom: 22px;
}
.stat {
  padding: 14px 16px; border-radius: 10px;
  background: rgba(80, 150, 179, 0.05);
  border: 1px solid rgba(80, 150, 179, 0.15);
}
.stat.big {
  background: rgba(80, 150, 179, 0.08);
  border-color: rgba(80, 150, 179, 0.25);
}
.stat .num {
  font-family: var(--serif); font-style: italic;
  font-size: 26px; font-weight: 600;
  color: white; line-height: 1.1;
  letter-spacing: -0.01em;
}
.stat.big .num {
  font-size: 34px;
}
.stat .lbl {
  font-family: var(--mono); font-size: 9.5px;
  letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--steel-400);
  margin-top: 6px;
}
.stat .sub {
  font-family: var(--mono); font-size: 10px;
  color: var(--read-4); margin-top: 4px;
}

.sec-label {
  font-family: var(--mono); font-size: 10px;
  letter-spacing: 0.25em; text-transform: uppercase;
  color: var(--read-4);
  margin: 0 0 10px;
}

.grid {
  display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px;
  margin-bottom: 22px;
}
.grid .stat .num { font-size: 22px; }

.session-row {
  display: flex; flex-direction: column; gap: 8px;
  padding: 14px 16px; border-radius: 10px;
  background: rgba(20, 30, 42, 0.6);
  border: 1px solid rgba(168, 192, 220, 0.12);
  margin-bottom: 18px;
}
.sr-item {
  display: flex; justify-content: space-between;
  align-items: baseline; gap: 14px;
  font-family: var(--mono); font-size: 12px;
}
.sr-lbl {
  color: var(--read-4); letter-spacing: 0.12em; text-transform: uppercase;
  font-size: 10px;
}
.sr-val {
  color: var(--read-1); font-family: var(--serif); font-style: italic;
  font-size: 14px; font-weight: 500;
}
.sr-val.degraded { color: var(--warn); }
.sr-val.offline  { color: var(--err); }

.foot-note {
  font-family: var(--serif); font-style: italic;
  font-size: 13px; line-height: 1.55; color: var(--read-3);
  margin: 0;
}

.veil-enter-active, .veil-leave-active { transition: opacity 0.18s ease; }
.veil-enter-from,   .veil-leave-to    { opacity: 0; }
</style>
