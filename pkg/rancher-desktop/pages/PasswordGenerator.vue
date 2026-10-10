<template>
  <div class="pwgen">
    <!-- Header -->
    <div class="pwgen-header">
      <button
        type="button"
        class="pwgen-back"
        @click="$emit('back')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          class="h-4 w-4"
        >
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Back
      </button>
      <button
        v-if="showUseButton"
        type="button"
        class="pwgen-use-btn"
        @click="$emit('use-password', password)"
      >
        Use Password
      </button>
    </div>

    <!-- Scrollable content -->
    <div class="pwgen-scroll">
      <div class="pwgen-noir-copy">
        <p>Password Generator</p>
        <h1>Create something no one can guess.</h1>
        <span>Tune the recipe, then copy or use it without exposing anything else in your vault.</span>
      </div>
      <!-- Password display -->
      <div class="pwgen-display">
        <div class="pwgen-password-box">
          <span
            v-for="(ch, i) in passwordChars"
            :key="i"
            :class="ch.cls"
          >{{ ch.char }}</span>
        </div>
        <div class="pwgen-actions-row">
          <button
            type="button"
            class="pwgen-action-btn"
            title="Copy to clipboard"
            @click="copyPassword"
          >
            <svg
              v-if="!copied"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              class="h-4 w-4"
            >
              <rect
                x="9"
                y="9"
                width="13"
                height="13"
                rx="2"
              />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
            <svg
              v-else
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              class="h-4 w-4 text-sky-400"
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
            {{ copied ? 'Copied!' : 'Copy' }}
          </button>
          <button
            type="button"
            class="pwgen-action-btn"
            title="Generate new password"
            @click="regenerate"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              class="h-4 w-4"
            >
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
              <path d="M16 16h5v5" />
            </svg>
            Regenerate
          </button>
        </div>

        <!-- Strength meter -->
        <div class="pwgen-strength">
          <div class="pwgen-strength-bar">
            <div
              class="pwgen-strength-fill"
              :class="strengthClass"
              :style="{ width: strengthPercent + '%' }"
            />
          </div>
          <span
            class="pwgen-strength-label"
            :class="strengthClass"
          >{{ strengthLabel }}</span>
        </div>
      </div>

      <!-- Mode toggle -->
      <div class="pwgen-mode-toggle">
        <button
          type="button"
          :class="{ active: mode === 'password' }"
          @click="mode = 'password'"
        >
          Password
        </button>
        <button
          type="button"
          :class="{ active: mode === 'passphrase' }"
          @click="mode = 'passphrase'"
        >
          Passphrase
        </button>
      </div>

      <!-- Password options -->
      <div
        v-if="mode === 'password'"
        class="pwgen-options"
      >
        <div class="pwgen-option-row">
          <label class="pwgen-option-label">Length</label>
          <div class="pwgen-slider-group">
            <input
              v-model.number="opts.length"
              type="range"
              min="8"
              max="128"
              class="pwgen-slider"
            >
            <input
              v-model.number="opts.length"
              type="number"
              min="8"
              max="128"
              class="pwgen-num-input"
            >
          </div>
        </div>

        <div class="pwgen-option-row">
          <label class="pwgen-option-label">Characters</label>
          <div class="pwgen-checks">
            <label class="pwgen-check">
              <input
                v-model="opts.uppercase"
                type="checkbox"
              >
              <span>A-Z</span>
            </label>
            <label class="pwgen-check">
              <input
                v-model="opts.lowercase"
                type="checkbox"
              >
              <span>a-z</span>
            </label>
            <label class="pwgen-check">
              <input
                v-model="opts.numbers"
                type="checkbox"
              >
              <span>0-9</span>
            </label>
            <label class="pwgen-check">
              <input
                v-model="opts.symbols"
                type="checkbox"
              >
              <span>!@#$%</span>
            </label>
          </div>
        </div>

        <div class="pwgen-option-row">
          <label class="pwgen-option-label">Minimum numbers</label>
          <input
            v-model.number="opts.minNumbers"
            type="number"
            min="0"
            max="9"
            class="pwgen-num-input"
          >
        </div>

        <div class="pwgen-option-row">
          <label class="pwgen-option-label">Minimum symbols</label>
          <input
            v-model.number="opts.minSymbols"
            type="number"
            min="0"
            max="9"
            class="pwgen-num-input"
          >
        </div>

        <div class="pwgen-option-row">
          <label class="pwgen-check">
            <input
              v-model="opts.avoidAmbiguous"
              type="checkbox"
            >
            <span>Avoid ambiguous characters (0O1lI|)</span>
          </label>
        </div>
      </div>

      <!-- Passphrase options -->
      <div
        v-if="mode === 'passphrase'"
        class="pwgen-options"
      >
        <div class="pwgen-option-row">
          <label class="pwgen-option-label">Words</label>
          <div class="pwgen-slider-group">
            <input
              v-model.number="phraseOpts.wordCount"
              type="range"
              min="3"
              max="10"
              class="pwgen-slider"
            >
            <input
              v-model.number="phraseOpts.wordCount"
              type="number"
              min="3"
              max="10"
              class="pwgen-num-input"
            >
          </div>
        </div>

        <div class="pwgen-option-row">
          <label class="pwgen-option-label">Separator</label>
          <select
            v-model="phraseOpts.separator"
            class="pwgen-select"
          >
            <option value="-">
              Hyphen (-)
            </option>
            <option value=" ">
              Space
            </option>
            <option value=".">
              Period (.)
            </option>
            <option value="_">
              Underscore (_)
            </option>
            <option value="number">
              Number
            </option>
          </select>
        </div>

        <div class="pwgen-option-row">
          <label class="pwgen-check">
            <input
              v-model="phraseOpts.capitalize"
              type="checkbox"
            >
            <span>Capitalize words</span>
          </label>
        </div>

        <div class="pwgen-option-row">
          <label class="pwgen-check">
            <input
              v-model="phraseOpts.includeNumber"
              type="checkbox"
            >
            <span>Include a number</span>
          </label>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue';

import { WORDLIST, secureRandomInt } from '@pkg/agent/utils/wordlist';

defineProps<{
  showUseButton?: boolean;
}>();

defineEmits<{
  back:           [];
  'use-password': [password: string];
}>();

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%^&*()_+-=[]{}|;:,.<>?';
const AMBIGUOUS = '0O1lI|';

type Mode = 'password' | 'passphrase';
const mode = ref<Mode>('password');
const password = ref('');
const copied = ref(false);

const opts = reactive({
  length:         20,
  uppercase:      true,
  lowercase:      true,
  numbers:        true,
  symbols:        true,
  minNumbers:     1,
  minSymbols:     1,
  avoidAmbiguous: false,
});

const phraseOpts = reactive({
  wordCount:     4,
  separator:     '-',
  capitalize:    true,
  includeNumber: true,
});

// ── Password generation ──

function getCharPool(): string {
  let pool = '';
  if (opts.uppercase) pool += UPPER;
  if (opts.lowercase) pool += LOWER;
  if (opts.numbers) pool += DIGITS;
  if (opts.symbols) pool += SYMBOLS;
  if (!pool) pool = LOWER; // fallback
  if (opts.avoidAmbiguous) {
    pool = pool.split('').filter(c => !AMBIGUOUS.includes(c)).join('');
  }
  return pool;
}

function generatePassword(): string {
  const pool = getCharPool();
  const chars: string[] = [];

  // Ensure minimum required characters first
  const requiredChars: string[] = [];
  if (opts.numbers && opts.minNumbers > 0) {
    const src = opts.avoidAmbiguous ? DIGITS.replace('0', '') : DIGITS;
    for (let i = 0; i < opts.minNumbers && src.length > 0; i++) {
      requiredChars.push(src[secureRandomInt(src.length)]);
    }
  }
  if (opts.symbols && opts.minSymbols > 0) {
    const src = opts.avoidAmbiguous ? SYMBOLS.replace('|', '') : SYMBOLS;
    for (let i = 0; i < opts.minSymbols && src.length > 0; i++) {
      requiredChars.push(src[secureRandomInt(src.length)]);
    }
  }

  // Fill remaining length from pool
  const remaining = Math.max(0, opts.length - requiredChars.length);
  for (let i = 0; i < remaining; i++) {
    chars.push(pool[secureRandomInt(pool.length)]);
  }

  // Insert required chars at random positions
  for (const rc of requiredChars) {
    const pos = secureRandomInt(chars.length + 1);
    chars.splice(pos, 0, rc);
  }

  return chars.join('');
}

function generatePassphrase(): string {
  const words: string[] = [];
  for (let i = 0; i < phraseOpts.wordCount; i++) {
    let word = WORDLIST[secureRandomInt(WORDLIST.length)];
    if (phraseOpts.capitalize) {
      word = word[0].toUpperCase() + word.slice(1);
    }
    words.push(word);
  }

  if (phraseOpts.includeNumber) {
    const idx = secureRandomInt(words.length);
    words[idx] = words[idx] + secureRandomInt(100);
  }

  const sep = phraseOpts.separator === 'number'
    ? String(secureRandomInt(10))
    : phraseOpts.separator;

  return words.join(sep);
}

function regenerate() {
  password.value = mode.value === 'password' ? generatePassword() : generatePassphrase();
  copied.value = false;
}

// ── Color-coded characters ──

const passwordChars = computed(() => {
  return password.value.split('').map(char => {
    let cls = 'ch-lower';
    if (UPPER.includes(char)) cls = 'ch-upper';
    else if (DIGITS.includes(char)) cls = 'ch-number';
    else if (SYMBOLS.includes(char) || (!UPPER.includes(char) && !LOWER.includes(char) && !DIGITS.includes(char))) cls = 'ch-symbol';
    return { char, cls };
  });
});

// ── Strength calculation ──

const entropy = computed(() => {
  if (mode.value === 'passphrase') {
    // Each word: log2(wordlist size) bits
    const bitsPerWord = Math.log2(WORDLIST.length);
    let bits = phraseOpts.wordCount * bitsPerWord;
    if (phraseOpts.includeNumber) bits += Math.log2(100); // random 0-99
    return bits;
  }

  const pool = getCharPool();
  if (pool.length <= 1) return 0;
  return opts.length * Math.log2(pool.length);
});

const strengthPercent = computed(() => {
  return Math.min(100, (entropy.value / 128) * 100);
});

const strengthLabel = computed(() => {
  const e = entropy.value;
  if (e < 40) return 'Weak';
  if (e < 60) return 'Fair';
  if (e < 80) return 'Strong';
  return 'Very Strong';
});

const strengthClass = computed(() => {
  const e = entropy.value;
  if (e < 40) return 'strength-weak';
  if (e < 60) return 'strength-fair';
  if (e < 80) return 'strength-strong';
  return 'strength-very-strong';
});

// ── Clipboard ──

async function copyPassword() {
  try {
    await navigator.clipboard.writeText(password.value);
    copied.value = true;
    setTimeout(() => { copied.value = false }, 2000);
  } catch {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = password.value;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    copied.value = true;
    setTimeout(() => { copied.value = false }, 2000);
  }
}

// Auto-regenerate on settings change
watch([mode, opts, phraseOpts], regenerate, { deep: true });

onMounted(regenerate);
</script>

<style scoped>
.pwgen {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-surface, #0d1117);
  color: var(--text-primary, #e6edf3);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

/* ── Header ── */
.pwgen-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border-default, #21262d);
  background: var(--bg-surface-alt, #161b22);
}

.pwgen-back {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary, #8b949e);
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: color 0.15s, background 0.15s;
}

.pwgen-back:hover {
  color: var(--text-primary, #e6edf3);
  background: var(--bg-surface-hover, #1c2128);
}

.pwgen-use-btn {
  padding: 6px 16px;
  font-size: 13px;
  font-weight: 600;
  background: var(--accent-primary, #38bdf8);
  color: var(--bg-surface, #0d1117);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
}

.pwgen-use-btn:hover {
  background: #7dd3fc;
}

/* ── Scroll ── */
.pwgen-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 24px 20px 40px;
  max-width: 560px;
  margin: 0 auto;
  width: 100%;
}

.pwgen-scroll > * + * {
  margin-top: 20px;
}

/* ── Password display ── */
.pwgen-display {
  background: var(--bg-surface-alt, #161b22);
  border: 1px solid var(--border-default, #21262d);
  border-radius: 12px;
  padding: 20px;
}

.pwgen-password-box {
  font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
  font-size: 18px;
  line-height: 1.6;
  word-break: break-all;
  letter-spacing: 0.05em;
  padding: 16px;
  background: var(--bg-surface, #0d1117);
  border: 1px solid var(--border-default, #21262d);
  border-radius: 8px;
  min-height: 60px;
  user-select: all;
}

.ch-lower  { color: var(--text-primary, #e6edf3); }
.ch-upper  { color: #89b4fa; }
.ch-number { color: #a6e3a1; }
.ch-symbol { color: #fab387; }

/* ── Actions row ── */
.pwgen-actions-row {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.pwgen-action-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  background: var(--bg-surface, #0d1117);
  color: var(--text-secondary, #8b949e);
  border: 1px solid var(--border-default, #21262d);
  border-radius: 6px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.pwgen-action-btn:hover {
  color: var(--text-primary, #e6edf3);
  border-color: var(--text-secondary, #8b949e);
}

/* ── Strength meter ── */
.pwgen-strength {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}

.pwgen-strength-bar {
  flex: 1;
  height: 4px;
  background: var(--bg-surface, #0d1117);
  border-radius: 2px;
  overflow: hidden;
}

.pwgen-strength-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s, background 0.3s;
}

.pwgen-strength-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  white-space: nowrap;
}

.strength-weak        { background: #f85149; color: #f85149; }
.strength-fair        { background: #d29922; color: #d29922; }
.strength-strong      { background: #3fb950; color: #3fb950; }
.strength-very-strong { background: #58a6ff; color: #58a6ff; }

/* ── Mode toggle ── */
.pwgen-mode-toggle {
  display: flex;
  background: var(--bg-surface-alt, #161b22);
  border: 1px solid var(--border-default, #21262d);
  border-radius: 8px;
  overflow: hidden;
}

.pwgen-mode-toggle button {
  flex: 1;
  padding: 10px;
  font-size: 13px;
  font-weight: 600;
  background: transparent;
  color: var(--text-secondary, #8b949e);
  border: none;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.pwgen-mode-toggle button.active {
  background: var(--accent-primary, #38bdf8);
  color: var(--bg-surface, #0d1117);
}

.pwgen-mode-toggle button:not(.active):hover {
  color: var(--text-primary, #e6edf3);
  background: var(--bg-surface-hover, #1c2128);
}

/* ── Options ── */
.pwgen-options {
  background: var(--bg-surface-alt, #161b22);
  border: 1px solid var(--border-default, #21262d);
  border-radius: 12px;
  padding: 16px 20px;
}

.pwgen-option-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0;
}

.pwgen-option-row + .pwgen-option-row {
  border-top: 1px solid var(--border-default, #21262d);
}

.pwgen-option-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary, #e6edf3);
}

.pwgen-slider-group {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  max-width: 260px;
}

.pwgen-slider {
  flex: 1;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: var(--border-default, #21262d);
  border-radius: 2px;
  outline: none;
}

.pwgen-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--accent-primary, #38bdf8);
  cursor: pointer;
  border: 2px solid var(--bg-surface, #0d1117);
}

.pwgen-num-input {
  width: 52px;
  padding: 4px 8px;
  font-size: 13px;
  text-align: center;
  background: var(--bg-surface, #0d1117);
  color: var(--text-primary, #e6edf3);
  border: 1px solid var(--border-default, #21262d);
  border-radius: 6px;
  outline: none;
}

.pwgen-num-input:focus {
  border-color: var(--accent-primary, #38bdf8);
}

.pwgen-checks {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.pwgen-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-primary, #e6edf3);
  cursor: pointer;
}

.pwgen-check input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent-primary, #38bdf8);
  cursor: pointer;
}

.pwgen-select {
  padding: 6px 12px;
  font-size: 13px;
  background: var(--bg-surface, #0d1117);
  color: var(--text-primary, #e6edf3);
  border: 1px solid var(--border-default, #21262d);
  border-radius: 6px;
  outline: none;
}

.pwgen-select:focus {
  border-color: var(--accent-primary, #38bdf8);
}

.pwgen-noir-copy {
  display: none;
}

:global(.theme-noir) .pwgen {
  background: var(--nx-paper);
  color: var(--nx-read-1);
}

:global(.theme-noir) .pwgen-header {
  min-height: 56px;
  padding: 0 30px;
  border-bottom-color: var(--nx-hair);
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / 0.62);
  backdrop-filter: blur(14px);
}

:global(.theme-noir) .pwgen-back,
:global(.theme-noir) .pwgen-use-btn {
  height: 34px;
  padding: 0 14px;
  border-radius: 17px;
  transition: transform 0.58s linear(0,.0258,.09,.1763,.2732,.3724,.4683,.5573,.6376,.7082,.7689,.8202,.8628,.8976,.9256,.9476,.9648,.9778,.9875,.9945,.9994,1.0026,1.0047,1.0058,1.0062,1.0062,1.0059,1.0055,1.0049,1.0043,1.0036,1.0031,1.0025,1.002,1.0016,1.0013,1), background 0.18s;
}

:global(.theme-noir) .pwgen-use-btn {
  background: linear-gradient(180deg, var(--nx-accent-2), var(--nx-accent));
  color: #fff;
  box-shadow: 0 0 16px color-mix(in srgb, var(--nx-accent) 28%, transparent);
}

:global(.theme-noir) .pwgen-back:active,
:global(.theme-noir) .pwgen-use-btn:active {
  transform: scale(0.94);
}

:global(.theme-noir) .pwgen-scroll {
  max-width: 760px;
  padding: 30px 34px 48px;
}

:global(.theme-noir) .pwgen-noir-copy {
  display: block;
  margin-bottom: 22px;
  animation: vault-generator-in 0.35s ease both;
}

:global(.theme-noir) .pwgen-noir-copy p {
  margin: 0 0 7px;
  color: var(--nx-accent-2);
  font-family: ui-monospace, 'SF Mono', monospace;
  font-size: 10.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

:global(.theme-noir) .pwgen-noir-copy h1 {
  margin: 0;
  color: var(--nx-read-1);
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 30px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.18;
}

:global(.theme-noir) .pwgen-noir-copy span {
  display: block;
  margin-top: 7px;
  color: var(--nx-read-3);
  font-size: 14px;
}

:global(.theme-noir) .pwgen-display {
  padding: 20px;
  border-color: color-mix(in srgb, var(--nx-accent-2) 25%, transparent);
  border-radius: 20px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--nx-accent) 16%, transparent), color-mix(in srgb, var(--nx-accent) 3%, transparent));
}

:global(.theme-noir) .pwgen-password-box {
  min-height: 72px;
  padding: 18px;
  border-color: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 10%, transparent);
  border-radius: 14px;
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / 0.76);
  color: var(--nx-read-2);
  box-shadow: inset 0 1px 0 rgb(from var(--nx-ink) calc(r + 12) calc(g + 10) calc(b + 7) / 0.018);
}

:global(.theme-noir) .pwgen-action-btn {
  min-height: 32px;
  border-color: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 14%, transparent);
  border-radius: 16px;
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / 0.45);
  color: var(--nx-read-3);
  transition: transform 0.58s linear(0,.0258,.09,.1763,.2732,.3724,.4683,.5573,.6376,.7082,.7689,.8202,.8628,.8976,.9256,.9476,.9648,.9778,.9875,.9945,.9994,1.0026,1.0047,1.0058,1.0062,1.0062,1.0059,1.0055,1.0049,1.0043,1.0036,1.0031,1.0025,1.002,1.0016,1.0013,1), border-color 0.18s, color 0.18s;
}

:global(.theme-noir) .pwgen-action-btn:active {
  transform: scale(0.92);
}

:global(.theme-noir) .pwgen-strength-bar {
  height: 6px;
  border-radius: 3px;
  background: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 9%, transparent);
}

:global(.theme-noir) .pwgen-strength-fill {
  background: linear-gradient(90deg, var(--nx-accent), var(--nx-accent-2));
  box-shadow: 0 0 10px color-mix(in srgb, var(--nx-accent) 38%, transparent);
}

:global(.theme-noir) .pwgen-strength-fill.strength-strong,
:global(.theme-noir) .pwgen-strength-fill.strength-very-strong {
  background: linear-gradient(90deg, var(--nx-accent), var(--nx-success));
}

:global(.theme-noir) .pwgen-strength-label {
  color: var(--nx-read-3);
  font-family: ui-monospace, 'SF Mono', monospace;
}

:global(.theme-noir) .pwgen-mode-toggle {
  gap: 3px;
  padding: 3px;
  border: 0;
  border-radius: 18px;
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / 0.64);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 10%, transparent);
}

:global(.theme-noir) .pwgen-mode-toggle button {
  min-height: 32px;
  padding: 0 16px;
  border-radius: 16px;
  color: var(--nx-read-4);
}

:global(.theme-noir) .pwgen-mode-toggle button.active {
  background: linear-gradient(180deg, color-mix(in srgb, var(--nx-accent) 32%, transparent), color-mix(in srgb, var(--nx-accent) 16%, transparent));
  color: var(--nx-read-1);
  box-shadow: inset 0 0 0 0.5px color-mix(in srgb, var(--nx-accent-2) 55%, transparent), 0 0 14px color-mix(in srgb, var(--nx-accent) 25%, transparent);
}

:global(.theme-noir) .pwgen-options {
  padding: 18px 20px;
  border-color: var(--nx-hair);
  border-radius: 18px;
  background: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 3.5%, transparent);
  box-shadow: inset 0 1px 0 rgb(from var(--nx-ink) calc(r + 12) calc(g + 10) calc(b + 7) / 0.015);
}

:global(.theme-noir) .pwgen-option-row + .pwgen-option-row {
  border-top-color: var(--nx-hair);
}

:global(.theme-noir) .pwgen-option-label,
:global(.theme-noir) .pwgen-check {
  color: var(--nx-read-2);
}

:global(.theme-noir) .pwgen-num-input,
:global(.theme-noir) .pwgen-select {
  min-height: 36px;
  border: 0;
  border-radius: 11px;
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / 0.68);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 12%, transparent);
  color: var(--nx-read-1);
}

:global(.theme-noir) .pwgen-slider {
  background: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 12%, transparent);
}

:global(.theme-noir) .pwgen-slider::-webkit-slider-thumb {
  width: 18px;
  height: 18px;
  border: 3px solid var(--nx-surface);
  background: var(--nx-accent-2);
  box-shadow: 0 0 10px color-mix(in srgb, var(--nx-accent-2) 50%, transparent);
}

@keyframes vault-generator-in {
  from { opacity: 0; filter: blur(8px); transform: translateY(8px); }
  to { opacity: 1; filter: blur(0); transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  :global(.theme-noir) .pwgen-noir-copy {
    animation: none;
  }

  :global(.theme-noir) .pwgen-back,
  :global(.theme-noir) .pwgen-use-btn,
  :global(.theme-noir) .pwgen-action-btn {
    transition-duration: 0.01ms;
  }
}
</style>
