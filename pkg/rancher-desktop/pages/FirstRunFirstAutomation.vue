<template>
  <div class="ffa p-6">
    <form @submit.prevent="handleNext">
      <h2 class="ffa-title">
        What should Sulla take off your plate first?
      </h2>
      <p class="ffa-lead">
        Pick a starter automation or describe your own. When setup finishes, Sulla opens with it ready to go.
        Press Enter and Sulla builds it, asks for anything it needs, and runs it once so you can see the result.
      </p>

      <div
        class="ffa-grid"
        role="radiogroup"
        aria-label="Starter automations"
      >
        <button
          v-for="starter in starters"
          :key="starter.id"
          type="button"
          role="radio"
          class="ffa-option"
          :class="{ 'is-selected': selectedId === starter.id }"
          :aria-checked="selectedId === starter.id"
          @click="selectedId = starter.id"
        >
          <span class="ffa-icon">{{ starter.icon }}</span>
          <span class="ffa-when">{{ starter.when }}</span>
          <b>{{ starter.title }}</b>
          <span class="ffa-desc">{{ starter.description }}</span>
        </button>
      </div>

      <label
        class="ffa-custom"
        :class="{ 'is-selected': selectedId === 'custom' }"
      >
        <span class="ffa-custom-label">Or describe your own</span>
        <textarea
          v-model="customPrompt"
          rows="3"
          placeholder="Every Friday, pull last week's sales from Stripe and email me a summary with anything unusual flagged."
          @focus="selectedId = 'custom'"
        />
      </label>

      <p
        v-if="error"
        class="ffa-error"
      >
        {{ error }}
      </p>

      <div class="ffa-actions">
        <button
          type="button"
          class="ffa-back"
          @click="$emit('back')"
        >
          Back
        </button>
        <div class="ffa-right">
          <button
            type="button"
            class="ffa-skip"
            @click="skip"
          >
            I'll explore on my own
          </button>
          <button
            type="submit"
            class="ffa-btn"
            :disabled="!canContinue"
          >
            Set this up →
          </button>
        </div>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import { FIRST_RUN_STARTER_PROMPT_KEY } from './firstRunStarter';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';

const emit = defineEmits<{
  next: [];
  back: [];
}>();

interface Starter {
  id:          string;
  icon:        string;
  when:        string;
  title:       string;
  description: string;
  prompt:      string;
}

const FINISH = 'Ask me for anything you need, like which accounts to connect, then run it once so I can see the result.';

const starters: Starter[] = [
  {
    id:          'briefing',
    icon:        '🗞️',
    when:        'Weekdays at 7 AM',
    title:       'Morning briefing',
    description: 'Your calendar, the emails that need you, and open tasks on one page.',
    prompt:      `Set up an automation that every weekday at 7 AM sends me a one-page briefing: today's calendar, the emails that need my attention, and my open tasks. ${ FINISH }`,
  },
  {
    id:          'inbox',
    icon:        '📥',
    when:        'Every hour',
    title:       'Inbox triage',
    description: 'Sorts new mail, drafts routine replies, and flags only what needs you.',
    prompt:      `Set up an automation that every hour sorts my new email, drafts replies to the routine ones for my approval, and flags only the messages that need me. ${ FINISH }`,
  },
  {
    id:          'leads',
    icon:        '📨',
    when:        'When a lead comes in',
    title:       'Lead follow-up',
    description: 'Researches the lead and drafts a reply in your voice for approval.',
    prompt:      `Set up an automation that, whenever a new lead comes in, looks the lead up, drafts a reply in my voice, and waits for my approval before sending. ${ FINISH }`,
  },
  {
    id:          'invoices',
    icon:        '💸',
    when:        'Every Monday',
    title:       'Invoice chasing',
    description: 'Polite reminders for overdue invoices. The tough ones go to you.',
    prompt:      `Set up an automation that every Monday finds invoices unpaid for more than 14 days, sends each customer a polite reminder, and sends anything over 30 days to me instead. ${ FINISH }`,
  },
  {
    id:          'content',
    icon:        '✍️',
    when:        'Every Friday',
    title:       'Content from your notes',
    description: "Turns the week's notes into a blog post and social drafts.",
    prompt:      `Set up an automation that every Friday turns this week's notes and wins into a blog post draft and three social posts, and queues them for my review. ${ FINISH }`,
  },
  {
    id:          'report',
    icon:        '📊',
    when:        'First of the month',
    title:       'Monthly report',
    description: 'Pulls numbers from your tools and portals into a summary.',
    prompt:      `Set up an automation that on the first of every month pulls last month's key numbers from my tools, including sites without an export, and sends me a summary with anything unusual flagged. ${ FINISH }`,
  },
];

const selectedId = ref<string>('briefing');
const customPrompt = ref('');
const error = ref('');

const chosenPrompt = computed(() => {
  if (selectedId.value === 'custom') {
    const text = customPrompt.value.trim();

    return text ? `Set up an automation for me: ${ text }\n\n${ FINISH }` : '';
  }

  return starters.find(s => s.id === selectedId.value)?.prompt ?? '';
});

const canContinue = computed(() => !!chosenPrompt.value);

async function saveStarter(prompt: string) {
  try {
    await SullaSettingsModel.set(FIRST_RUN_STARTER_PROMPT_KEY, prompt, 'string');
  } catch (err) {
    // Non-fatal: setup must never block on the starter choice.
    console.warn('[FirstRunFirstAutomation] Failed to save starter prompt:', err);
  }
}

async function handleNext() {
  if (!chosenPrompt.value) {
    error.value = 'Pick a starter or describe what you want Sulla to do.';

    return;
  }
  error.value = '';
  await saveStarter(chosenPrompt.value);
  emit('next');
}

async function skip() {
  await saveStarter('');
  emit('next');
}
</script>

<style lang="scss" scoped>
.ffa-title {
  font-size: 28px;
  line-height: 1.15;
  font-weight: 800;
  letter-spacing: -.02em;
  margin: 8px 0 10px;
  color: var(--text-primary, #0f172a);
}

.ffa-lead {
  font-size: 15px;
  line-height: 1.6;
  color: var(--text-secondary, #475569);
  margin-bottom: 20px;
}

.ffa-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.ffa-option {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
  padding: 14px;
  border-radius: 12px;
  border: 1.5px solid var(--border-default, #e2e8f0);
  background: var(--bg-surface, #fff);
  color: var(--text-primary, #0f172a);
  cursor: pointer;
  transition: border-color .15s ease, box-shadow .15s ease;

  b { font-size: 14.5px; }

  &:hover { border-color: var(--accent-primary, #3d7fa0); }

  &.is-selected {
    border-color: var(--accent-primary, #3d7fa0);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-primary, #3d7fa0) 18%, transparent);
  }
}

.ffa-icon { font-size: 22px; }

.ffa-when {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .05em;
  text-transform: uppercase;
  color: var(--accent-primary, #3d7fa0);
}

.ffa-desc {
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-muted, #64748b);
}

.ffa-custom {
  display: block;
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1.5px dashed var(--border-default, #cbd5e1);

  &.is-selected { border-style: solid; border-color: var(--accent-primary, #3d7fa0); }

  textarea {
    width: 100%;
    margin-top: 6px;
    resize: vertical;
    border: none;
    outline: none;
    background: transparent;
    font: inherit;
    font-size: 14px;
    color: var(--text-primary, #0f172a);
  }
}

.ffa-custom-label {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-secondary, #475569);
}

.ffa-error {
  margin-top: 10px;
  font-size: 13px;
  color: var(--text-error, #b91c1c);
}

.ffa-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 22px;
}

.ffa-right {
  display: flex;
  align-items: center;
  gap: 14px;
}

.ffa-back,
.ffa-skip {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-muted, #64748b);
}

.ffa-btn {
  padding: 11px 20px;
  border-radius: 11px;
  border: none;
  font-weight: 700;
  font-size: 15px;
  color: #fff;
  background: var(--accent-primary, #3d7fa0);
  cursor: pointer;

  &:disabled { opacity: .5; cursor: not-allowed; }
}

@media (max-width: 720px) {
  .ffa-grid { grid-template-columns: 1fr 1fr; }
}

.theme-noir .ffa {
  --ffa-spring: linear(0,.0258,.09,.1763,.2732,.3724,.4683,.5573,.6376,.7082,.7689,.8202,.8628,.8976,.9256,.9476,.9648,.9778,.9875,.9945,.9994,1.0026,1.0047,1.0058,1.0062,1.0062,1.0059,1.0055,1.0049,1.0043,1.0036,1.0031,1.0025,1.002,1.0016,1.0013,1);
  color: var(--nx-read-2);
}

.theme-noir .ffa form::before {
  content: "FIRST AUTOMATION";
  display: block;
  margin-top: 5px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: .14em;
  color: var(--nx-accent-2);
}

.theme-noir .ffa-title {
  max-width: 690px;
  margin: 7px 0 8px;
  font-family: "Playfair Display", Georgia, serif;
  font-size: 34px;
  line-height: 1.08;
  font-weight: 600;
  letter-spacing: -.02em;
  color: var(--nx-read-1);
  text-wrap: balance;
}

.theme-noir .ffa-lead {
  margin-bottom: 20px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--nx-read-3);
}

.theme-noir .ffa-grid { gap: 8px; }

.theme-noir .ffa-option {
  position: relative;
  min-height: 146px;
  gap: 5px;
  padding: 15px;
  border-color: transparent;
  border-radius: 16px;
  background: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 3.5%, transparent);
  box-shadow: inset 0 0 0 1px var(--nx-hair);
  color: var(--nx-read-2);
  transition: transform .58s var(--ffa-spring), background .2s ease, box-shadow .25s ease;
}

.theme-noir .ffa-option::after {
  content: "";
  position: absolute;
  top: 14px;
  right: 14px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: radial-gradient(circle, transparent 0 25%, transparent 28% 100%);
  box-shadow: inset 0 0 0 1.5px var(--nx-read-5);
  transition: background .2s ease, box-shadow .2s ease, transform .58s var(--ffa-spring);
}

.theme-noir .ffa-option:hover {
  transform: translateY(-2px);
  border-color: transparent;
  background: color-mix(in srgb, var(--nx-accent) 7%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-accent-2) 20%, transparent), 0 14px 28px rgba(0, 0, 0, .16);
}

.theme-noir .ffa-option.is-selected {
  border-color: transparent;
  background: color-mix(in srgb, var(--nx-accent) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-accent-2) 42%, transparent), 0 0 22px color-mix(in srgb, var(--nx-accent) 10%, transparent);
}

.theme-noir .ffa-option.is-selected::after {
  background: radial-gradient(circle, var(--nx-accent-2) 0 33%, transparent 37% 100%);
  box-shadow: inset 0 0 0 1.5px var(--nx-accent-2), 0 0 8px color-mix(in srgb, var(--nx-accent-2) 70%, transparent);
  transform: scale(1.04);
}

.theme-noir .ffa-option b {
  color: var(--nx-read-1);
  font-size: 14px;
  font-weight: 600;
}

.theme-noir .ffa-icon {
  font-size: 21px;
  filter: grayscale(.2) saturate(.75);
}

.theme-noir .ffa-when {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 9.5px;
  font-weight: 500;
  letter-spacing: .1em;
  color: var(--nx-accent-2);
}

.theme-noir .ffa-desc {
  font-size: 12px;
  line-height: 1.45;
  color: var(--nx-read-4);
}

.theme-noir .ffa-custom {
  margin-top: 10px;
  padding: 13px 15px;
  border: 0;
  border-radius: 16px;
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .5);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 10%, transparent);
  transition: box-shadow .22s ease, background .22s ease;
}

.theme-noir .ffa-custom.is-selected {
  border: 0;
  background: color-mix(in srgb, var(--nx-accent) 6%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-accent-2) 42%, transparent), 0 0 18px color-mix(in srgb, var(--nx-accent) 8%, transparent);
}

.theme-noir .ffa-custom-label {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--nx-read-4);
}

.theme-noir .ffa-custom textarea {
  min-height: 68px;
  color: var(--nx-read-2);
  caret-color: var(--nx-accent-2);
}

.theme-noir .ffa-custom textarea::placeholder { color: var(--nx-read-5); }

.theme-noir .ffa-error { color: rgb(from var(--nx-danger) calc(r - 4) calc(g + 82) calc(b + 86)); }

.theme-noir .ffa-back,
.theme-noir .ffa-skip {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  font-weight: 500;
  color: var(--nx-read-4);
}

.theme-noir .ffa-back:hover,
.theme-noir .ffa-skip:hover { color: var(--nx-read-2); }

.theme-noir .ffa-btn {
  min-height: 40px;
  padding: 0 20px;
  border-radius: 20px;
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(180deg, var(--nx-accent-2), var(--nx-accent));
  box-shadow: 0 0 18px color-mix(in srgb, var(--nx-accent) 34%, transparent);
  transition: transform .58s var(--ffa-spring), box-shadow .2s ease;
}

.theme-noir .ffa-btn:not(:disabled):hover { box-shadow: 0 0 24px color-mix(in srgb, var(--nx-accent) 48%, transparent); }
.theme-noir .ffa-btn:not(:disabled):active { transform: scale(.95); }

@media (prefers-reduced-motion: reduce) {
  .theme-noir .ffa-option,
  .theme-noir .ffa-option::after,
  .theme-noir .ffa-btn {
    transition-duration: .01ms;
  }
}

/* Noir Light softens dark-only elevation shadows for paper surfaces. */
.theme-noir-light .ffa-option:hover {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-accent-2) 20%, transparent), 0 14px 28px color-mix(in srgb, var(--nx-ink) 8%, transparent);
}
</style>
