<!--
  Getting-started landing for a fresh chat thread.

  Mirrors the beats of the old ChatOptionsVariantB (editorial headline,
  quick-action cards, goals + business onboarding prompts) but rendered
  in the whisper aesthetic — serif italic headline, steel-blue accents,
  quiet mono labels.

  Nothing mutates state directly: every click emits an intent that the
  parent (ChatPage) translates into a controller.send(), a mode switch,
  or an onboarding-specific prompt.
-->
<template>
  <div class="empty">
    <!-- Section label -->
    <div class="e-kicker"><span class="d" /><span>Sulla AI Assistant</span></div>

    <!-- Editorial headline -->
    <h1 class="e-headline">What can I <em>help</em> with?</h1>
    <p class="e-tagline">Ask anything. Browse, schedule, extend — or just chat.</p>

    <!-- Onboarding cards (shown only when the matching identity file is missing) -->
    <div v-if="showGoals" class="e-card-wrap">
      <button class="e-card primary" type="button" @click="$emit('start-onboarding')">
        <span class="e-card-accent" />
        <span class="e-card-body">
          <span class="e-card-title">Tell Sulla about your goals</span>
          <span class="e-card-desc">Sulla aligns with how you work so she can help more precisely.</span>
        </span>
        <span class="e-card-arrow">→</span>
      </button>
    </div>

    <div v-if="showBusiness" class="e-card-wrap">
      <button class="e-card primary" type="button" @click="$emit('start-business-onboarding')">
        <span class="e-card-accent" />
        <span class="e-card-body">
          <span class="e-card-title">Put Sulla to work on your business</span>
          <span class="e-card-desc">Whether you're starting fresh or already running, Sulla can help you build, grow, and automate.</span>
        </span>
        <span class="e-card-arrow">→</span>
      </button>
    </div>

    <!-- Quick-start suggestion chips -->
    <div class="e-suggests">
      <button
        v-for="s in suggestions"
        :key="s"
        class="e-sug"
        type="button"
        @click="$emit('pick', s)"
      >{{ s }}</button>
    </div>

    <!-- Mode pick cards (Integrations, Browser) -->
    <div class="e-grid">
      <button class="e-card small" type="button" @click="$emit('mode', 'integrations')">
        <span class="e-card-accent" />
        <span class="e-card-body">
          <span class="e-card-title">Integrations</span>
          <span class="e-card-desc">Connect external systems + data sources</span>
        </span>
        <span class="e-card-arrow">→</span>
      </button>

      <button class="e-card small" type="button" @click="$emit('mode', 'browser')">
        <span class="e-card-accent" />
        <span class="e-card-body">
          <span class="e-card-title">Browser</span>
          <span class="e-card-desc">Open a web page in a new tab</span>
        </span>
        <span class="e-card-arrow">→</span>
      </button>

      <button class="e-card small" type="button" @click="$emit('mode', 'routines')">
        <span class="e-card-accent" />
        <span class="e-card-body">
          <span class="e-card-title">Routines</span>
          <span class="e-card-desc">Automate recurring work as a workflow</span>
        </span>
        <span class="e-card-arrow">→</span>
      </button>

      <button class="e-card small" type="button" @click="$emit('mode', 'calendar')">
        <span class="e-card-accent" />
        <span class="e-card-body">
          <span class="e-card-title">Calendar</span>
          <span class="e-card-desc">Schedule + see what's coming up</span>
        </span>
        <span class="e-card-arrow">→</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  suggestions:    readonly string[];
  showGoals?:     boolean;
  showBusiness?:  boolean;
}>();

defineEmits<{
  (e: 'pick', text: string): void;
  (e: 'mode', mode: 'integrations' | 'browser' | 'routines' | 'calendar'): void;
  (e: 'start-onboarding'): void;
  (e: 'start-business-onboarding'): void;
}>();
</script>

<style scoped>
.empty {
  position: absolute; inset: 0;
  z-index: 6;
  overflow-y: auto; overflow-x: hidden;
  padding: 90px 10% calc(var(--scroller-pad-b, 240px) + 40px);
  display: flex; flex-direction: column;
  align-items: center;
}
.empty::-webkit-scrollbar { width: 8px; }
.empty::-webkit-scrollbar-track { background: transparent; }
.empty::-webkit-scrollbar-thumb { background: rgba(168, 192, 220, 0.18); border-radius: 4px; }

/* ─── Section label ─── */
.e-kicker {
  font-family: var(--mono); font-size: 10px;
  letter-spacing: 0.4em; text-transform: uppercase;
  color: var(--steel-400);
  margin-bottom: 24px;
  display: inline-flex; align-items: center; gap: 14px;
}
.e-kicker::before,
.e-kicker::after {
  content: ""; width: 28px; height: 1px; background: var(--steel-500); opacity: 0.5;
}
.e-kicker .d {
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--steel-400);
  box-shadow: 0 0 8px var(--steel-400);
  animation: chat-pulse 1.5s infinite;
}

/* ─── Editorial headline ─── */
.e-headline {
  font-family: var(--serif);
  font-weight: 600; font-style: italic;
  font-size: clamp(2.4rem, 5vw, 3.6rem);
  line-height: 1.1; letter-spacing: -0.015em;
  color: white;
  text-align: center;
  margin: 0 0 14px;
}
.e-headline em {
  font-style: italic;
  color: var(--steel-400);
  text-shadow: 0 0 40px rgba(106, 176, 204, 0.5);
}

.e-tagline {
  font-family: var(--serif); font-style: italic;
  font-size: 17px; line-height: 1.65;
  color: var(--read-3);
  text-align: center;
  max-width: 560px;
  margin: 0 0 36px;
}

/* ─── Suggestion chips (quick prompts) ─── */
.e-suggests {
  display: flex; gap: 10px; flex-wrap: wrap;
  justify-content: center;
  margin-bottom: 36px;
  max-width: 760px;
}
.e-sug {
  padding: 9px 16px; border-radius: 100px;
  font-family: var(--serif); font-style: italic; font-size: 13px;
  background: rgba(20, 30, 42, 0.55);
  border: 1px solid rgba(168, 192, 220, 0.2);
  color: var(--read-2);
  cursor: pointer; transition: all 0.15s ease;
}
.e-sug:hover {
  background: rgba(80, 150, 179, 0.12);
  border-color: var(--steel-400);
  color: white;
  box-shadow: 0 0 14px rgba(106, 176, 204, 0.22);
}

/* ─── Action cards ─── */
.e-card-wrap {
  width: 100%; max-width: 560px;
  margin-bottom: 14px;
}
.e-card {
  width: 100%;
  display: flex; align-items: stretch;
  background: rgba(20, 30, 42, 0.55);
  border: 1px solid rgba(168, 192, 220, 0.18);
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer; text-align: left;
  padding: 0;
  font-family: inherit; color: inherit;
  transition: all 0.2s ease;
  backdrop-filter: blur(8px);
}
.e-card:hover {
  border-color: var(--steel-400);
  background: rgba(20, 30, 42, 0.82);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4), 0 0 24px rgba(106, 176, 204, 0.15);
}
.e-card.primary {
  background:
    radial-gradient(ellipse at top right, rgba(80, 150, 179, 0.12), transparent 70%),
    rgba(20, 30, 42, 0.6);
}

.e-card-accent {
  width: 3px; flex-shrink: 0;
  background: rgba(168, 192, 220, 0.3);
  transition: background 0.2s ease, box-shadow 0.2s ease;
}
.e-card.primary .e-card-accent {
  width: 4px;
  background: var(--steel-400);
  box-shadow: 0 0 14px var(--steel-400);
}
.e-card:hover .e-card-accent {
  background: var(--steel-400);
  box-shadow: 0 0 14px var(--steel-400);
}

.e-card-body {
  display: flex; flex-direction: column; gap: 4px;
  padding: 16px 18px;
  flex: 1; min-width: 0;
}
.e-card-title {
  font-family: var(--serif); font-style: italic;
  font-size: 17px; font-weight: 600;
  color: white;
  letter-spacing: -0.005em;
  line-height: 1.3;
}
.e-card-desc {
  font-family: var(--serif); font-style: italic;
  font-size: 14px; line-height: 1.5;
  color: var(--read-3);
}

.e-card-arrow {
  display: flex; align-items: center; justify-content: center;
  padding: 0 18px; flex-shrink: 0;
  font-family: var(--mono); font-size: 14px;
  color: var(--read-4);
  transition: color 0.2s ease, transform 0.2s ease;
}
.e-card:hover .e-card-arrow {
  color: var(--steel-400);
  transform: translateX(3px);
}

/* ─── Small mode-pick grid ─── */
.e-grid {
  display: grid; grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  width: 100%; max-width: 560px;
  margin-top: 20px;
}
.e-card.small {
  background: rgba(20, 30, 42, 0.45);
}
.e-card.small .e-card-body {
  padding: 13px 16px;
}
.e-card.small .e-card-title { font-size: 15px; }
.e-card.small .e-card-desc  { font-size: 12.5px; }
.e-card.small .e-card-arrow { padding: 0 14px; font-size: 12.5px; }
</style>
