<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="labs-page">
    <div class="labs-header">
      <div class="labs-title-row">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="labs-icon">
          <path d="M9 3h6v11l3.5 5.5a1 1 0 0 1-.86 1.5H6.36a1 1 0 0 1-.86-1.5L9 14V3z"/>
          <path d="M6.5 14.5h11"/>
        </svg>
        <h1>Labs</h1>
        <span class="labs-badge">Experimental</span>
      </div>
      <p class="labs-subtitle">Early-access features. Things may change.</p>
    </div>

    <div class="labs-grid">
      <!-- Capture Studio -->
      <div class="labs-card" @click="openCaptureStudio">
        <div class="card-icon">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M23 7l-7 5 7 5V7z"/>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
          </svg>
        </div>
        <div class="card-body">
          <h3>Capture Studio</h3>
          <p>Multi-track recorder — screen, camera, mic, and system audio in separate files. Includes a floating teleprompter with word-by-word highlighting.</p>
        </div>
        <div class="card-footer">
          <span class="card-status" :class="{ loading: launching }">
            {{ launching ? 'Opening…' : 'Click to open' }}
          </span>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M5 12h14M12 5l7 7-7 7"/>
          </svg>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const launching = ref(false);

async function openCaptureStudio() {
  if (launching.value) return;
  launching.value = true;
  try {
    await ipcRenderer.invoke('open-capture-studio');
  } finally {
    launching.value = false;
  }
}
</script>

<style scoped>
.labs-page {
  height: 100%;
  overflow-y: auto;
  padding: 40px 48px;
  background: var(--bg-page);
  color: var(--text-primary);
}

.labs-header {
  margin-bottom: 40px;
}

.labs-title-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.labs-icon {
  color: var(--status-success);
  opacity: 0.9;
}

h1 {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
}

.labs-badge {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--status-success);
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 2px 8px;
}

.labs-subtitle {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-primary);
  margin: 0;
}

.labs-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
  max-width: 900px;
}

.labs-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  padding: 24px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 14px;
  transition: border-color 0.2s ease, background 0.2s ease, transform 0.15s ease;
}

.labs-card:hover {
  border-color: var(--border-default);
  background: var(--bg-surface);
  transform: translateY(-2px);
}

.card-icon {
  width: 52px;
  height: 52px;
  border-radius: 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--status-success);
}

.card-body h3 {
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 6px;
}

.card-body p {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-primary);
  margin: 0;
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid var(--border-default);
}

.card-status {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--status-success);
  opacity: 0.7;
}

.card-status.loading {
  opacity: 0.4;
}

.card-footer svg {
  color: var(--status-success);
  opacity: 0.5;
  transition: opacity 0.2s, transform 0.2s;
}

.labs-card:hover .card-footer svg {
  opacity: 0.9;
  transform: translateX(3px);
}
</style>

<style scoped>
.labs-page {
  padding: 34px 38px;
  background:
    radial-gradient(90% 65% at 8% 0%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 58%),
    var(--bg-page);
}

.labs-header {
  margin-bottom: 28px;
  animation: noir-labs-in 0.48s cubic-bezier(.22, 1, .36, 1) both;
}

.labs-title-row {
  align-items: baseline;
  gap: 10px;
  margin-bottom: 6px;
}

.labs-icon {
  display: none;
}

h1 {
  color: var(--text-primary);
  font-family: var(--font-display), Georgia, serif;
  font-size: 32px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.labs-badge {
  color: var(--accent-hover);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-color: color-mix(in srgb, var(--accent-hover) 28%, transparent);
  border-radius: 9px;
}

.labs-subtitle {
  color: var(--text-muted);
  font-family: var(--font-body);
  font-size: 14px;
}

.labs-card {
  padding: 20px;
  border-color: var(--border-subtle);
  border-radius: 18px;
  background: color-mix(in srgb, var(--border-subtle) 21.875%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--border-subtle) 15.625%, transparent), 0 18px 42px color-mix(in srgb, var(--border-subtle) 20%, transparent);
  transition: transform 0.58s linear(0,.0258,.09,.1763,.2732,.3724,.4683,.5573,.6376,.7082,.7689,.8202,.8628,.8976,.9256,.9476,.9648,.9778,.9875,.9945,.9994,1.0026,1.0047,1.0058,1.0062,1.0062,1.0059,1.0055,1.0049,1.0043,1.0036,1.0031,1.0025,1.002,1.0016,1.0013,1), border-color 0.2s ease, background 0.2s ease;
}

.labs-card:hover {
  border-color: color-mix(in srgb, var(--accent-hover) 35%, transparent);
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 14%, transparent), color-mix(in srgb, var(--accent) 3.5%, transparent));
  transform: translateY(-3px);
}

.card-icon {
  width: 48px;
  height: 48px;
  color: var(--accent-hover);
  background: linear-gradient(145deg, color-mix(in srgb, var(--accent) 20%, transparent), color-mix(in srgb, var(--accent) 6%, transparent));
  border-color: color-mix(in srgb, var(--accent-hover) 30%, transparent);
  border-radius: 14px;
  box-shadow: 0 0 24px color-mix(in srgb, var(--accent) 12%, transparent);
}

.card-body h3 {
  color: var(--text-primary);
  font-family: var(--font-display), Georgia, serif;
  font-size: 19px;
}

.card-body p { color: var(--text-muted); }
.card-footer { border-color: var(--border-subtle); }
.card-status,
.card-footer svg { color: var(--accent-hover); }

@keyframes noir-labs-in {
  from { opacity: 0; transform: translateY(8px); filter: blur(8px); }
  to { opacity: 1; transform: none; filter: none; }
}

@media (prefers-reduced-motion: reduce) {
  .labs-header { animation: none; }
  .labs-card { transition-duration: 0.01ms; }
}
</style>
