<template>
  <!-- VARIANT B: Editorial Landing
       Magazine/editorial aesthetic. Big Playfair Display serif headline,
       monospace section label above, green left-border pull quote vibe,
       editorial card grid for actions. -->
  <div class="vb-root">
    <!-- Section label -->
    <div class="vb-section-label">Sulla AI Assistant</div>

    <!-- Editorial headline -->
    <h1 class="vb-headline">
      What can I<br><em>help</em> with?
    </h1>

    <!-- Subtle tagline -->
    <p class="vb-tagline">Ask anything. Browse, schedule, extend — or just chat.</p>

    <!-- Composer -->
    <div class="vb-composer-wrap">
      <AgentComposer
        v-model="localQuery"
        form-class="group/composer w-full"
        panel-class="z-10"
        :loading="loading"
        :show-overlay="false"
        :has-messages="false"
        :graph-running="graphRunning"
        :tts-playing="ttsPlaying"
        :is-recording="isRecording"
        :audio-level="audioLevel"
        :recording-duration="recordingDuration"
        :voice-configured="voiceConfigured"
        :model-selector="modelSelector"
        @send="$emit('send')"
        @stop="$emit('stop')"
        @primary-action="$emit('primary-action')"
        @toggle-recording="$emit('toggle-recording')"
        @stop-tts="$emit('stop-tts')"
      />
    </div>

    <!-- Action buttons grid -->
    <div class="vb-grid">
      <button
        type="button"
        class="vb-card"
        @click="$emit('pick', 'calendar')"
      >
        <div class="vb-card-accent" />
        <div class="vb-card-content">
          <span class="vb-card-title">Calendar</span>
        </div>
        <span class="vb-card-arrow">&rarr;</span>
      </button>

      <button
        type="button"
        class="vb-card"
        @click="$emit('pick', 'integrations')"
      >
        <div class="vb-card-accent" />
        <div class="vb-card-content">
          <span class="vb-card-title">Integrations</span>
        </div>
        <span class="vb-card-arrow">&rarr;</span>
      </button>

      <button
        type="button"
        class="vb-card"
        @click="$emit('pick', 'extensions')"
      >
        <div class="vb-card-accent" />
        <div class="vb-card-content">
          <span class="vb-card-title">Extensions</span>
        </div>
        <span class="vb-card-arrow">&rarr;</span>
      </button>

      <button
        type="button"
        class="vb-card"
        @click="$emit('pick', 'browser')"
      >
        <div class="vb-card-accent" />
        <div class="vb-card-content">
          <span class="vb-card-title">Browser</span>
        </div>
        <span class="vb-card-arrow">&rarr;</span>
      </button>
    </div>

    <!-- Goals onboarding card — hidden once human identity file exists -->
    <div
      v-if="showGoalsOnboarding"
      class="vb-onboarding"
    >
      <button
        type="button"
        class="vb-onboarding-btn"
        @click="$emit('start-onboarding')"
      >
        <div class="vb-onboarding-accent" />
        <div class="vb-onboarding-body">
          <span class="vb-onboarding-title">Tell Sulla About Your Goals</span>
          <span class="vb-onboarding-desc">Sulla will align herself with your goals to help you better accomplish them.</span>
        </div>
        <span class="vb-card-arrow">&rarr;</span>
      </button>
    </div>

    <!-- Business onboarding card — hidden once business identity file exists -->
    <div
      v-if="showBusinessOnboarding"
      class="vb-onboarding"
    >
      <button
        type="button"
        class="vb-onboarding-btn vb-onboarding-btn--business"
        @click="$emit('start-business-onboarding')"
      >
        <div class="vb-onboarding-accent vb-onboarding-accent--business" />
        <div class="vb-onboarding-body">
          <span class="vb-onboarding-title">Put Sulla to Work on Your Business</span>
          <span class="vb-onboarding-desc">Whether you're starting fresh or already running, Sulla can help you build, grow, and automate your business from day one.</span>
        </div>
        <span class="vb-card-arrow">&rarr;</span>
      </button>
    </div>

  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import AgentComposer from '../agent/AgentComposer.vue';

const props = defineProps<{
  query: string;
  loading: boolean;
  graphRunning: boolean;
  ttsPlaying?: boolean;
  isRecording?: boolean;
  audioLevel?: number;
  recordingDuration?: string;
  voiceConfigured?: boolean;
  modelSelector: any;
  isFirstChat?: boolean;
  showGoalsOnboarding?: boolean;
  showBusinessOnboarding?: boolean;
}>();

const emit = defineEmits<{
  'update:query': [value: string];
  send: [];
  stop: [];
  'primary-action': [];
  'toggle-recording': [];
  'stop-tts': [];
  pick: [mode: string];
  'start-onboarding': [];
  'start-business-onboarding': [];
}>();

const localQuery = computed({
  get: () => props.query,
  set: (v: string) => emit('update:query', v),
});

</script>

<style scoped>
.vb-root {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  max-width: 600px;
  margin: 0 auto;
  min-height: 100%;
}

/* ── Section label ── */
.vb-section-label {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 500;
  color: var(--text-link);
  letter-spacing: 0.3em;
  text-transform: uppercase;
  margin-bottom: 1.25rem;
}

/* ── Editorial headline ── */
.vb-headline {
  font-family: 'Playfair Display', Georgia, serif;
  font-weight: 900;
  font-size: clamp(2.2rem, 5vw, 3.5rem);
  line-height: 1.1;
  color: var(--text-primary);
  text-align: center;
  margin: 0 0 1rem;
}

.vb-headline em {
  font-style: italic;
  color: var(--text-link);
  text-shadow: 0 0 40px rgba(80, 150, 179, 0.4);
}

/* ── Tagline ── */
.vb-tagline {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  font-weight: 400;
  color: var(--text-muted);
  text-align: center;
  margin: 0 0 2.5rem;
  line-height: 1.6;
}

/* ── Composer ── */
.vb-composer-wrap {
  width: 100%;
  margin-bottom: 2.5rem;
}

/* ── Onboarding card ── */
.vb-onboarding:first-of-type {
  margin-top: 1.5rem;
}

.vb-onboarding {
  width: 100%;
  margin-bottom: 1.25rem;
  animation: onboardFadeIn 0.4s ease-out;
}

@keyframes onboardFadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.vb-onboarding-btn {
  display: flex;
  align-items: stretch;
  width: 100%;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  overflow: hidden;
  cursor: pointer;
  text-align: left;
  padding: 0;
  transition: border-color 0.3s, box-shadow 0.3s;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
}

.vb-onboarding-btn:hover {
  border-color: var(--text-link);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(80, 150, 179, 0.2);
}

.vb-onboarding-accent {
  width: 4px;
  flex-shrink: 0;
  background: var(--text-link);
}

.vb-onboarding-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0.75rem 1rem;
  flex: 1;
  min-width: 0;
}

.vb-onboarding-title {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-primary);
}

.vb-onboarding-desc {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  font-weight: 400;
  color: var(--text-dim);
}

.vb-onboarding-accent--business {
  background: var(--text-success, #4ade80);
}

.vb-onboarding-btn--business:hover {
  border-color: var(--text-success, #4ade80);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(74, 222, 128, 0.2);
}

/* ── Card grid ── */
.vb-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.75rem;
  width: 100%;
  margin-bottom: 2.5rem;
}

.vb-card {
  display: flex;
  align-items: stretch;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  text-align: left;
  padding: 0;
  transition: border-color 0.3s, box-shadow 0.3s;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
}

.vb-card:hover {
  border-color: var(--text-link);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(80, 150, 179, 0.15);
}

.vb-card-accent {
  width: 3px;
  flex-shrink: 0;
  background: var(--border-default);
  transition: background 0.3s;
}

.vb-card:hover .vb-card-accent {
  background: var(--text-link);
}

.vb-card-content {
  display: flex;
  align-items: center;
  padding: 0.6rem 0.875rem;
  flex: 1;
  min-width: 0;
}

.vb-card-title {
  font-family: var(--font-mono);
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: 0.01em;
}

.vb-card-arrow {
  display: flex;
  align-items: center;
  padding: 0 0.75rem;
  font-size: 0.9rem;
  color: var(--text-dim);
  transition: color 0.2s, transform 0.2s;
  flex-shrink: 0;
}

.vb-card:hover .vb-card-arrow {
  color: var(--text-link);
  transform: translateX(2px);
}
</style>
