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
  background: var(--bg, #0a0e17);
  color: var(--text, #e2e8f0);
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
  color: var(--green, #4ade80);
  opacity: 0.9;
}

h1 {
  font-family: var(--font-display, 'Playfair Display', serif);
  font-size: 28px;
  font-weight: 700;
  color: var(--text, #e2e8f0);
  margin: 0;
}

.labs-badge {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--green, #4ade80);
  background: rgba(74, 222, 128, 0.1);
  border: 1px solid rgba(74, 222, 128, 0.25);
  border-radius: 4px;
  padding: 2px 8px;
}

.labs-subtitle {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 13px;
  color: var(--text-muted, #64748b);
  margin: 0;
}

.labs-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
  max-width: 900px;
}

.labs-card {
  background: var(--surface-1, #111827);
  border: 1px solid var(--border, rgba(255,255,255,0.07));
  border-radius: 12px;
  padding: 24px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 14px;
  transition: border-color 0.2s ease, background 0.2s ease, transform 0.15s ease;
}

.labs-card:hover {
  border-color: rgba(74, 222, 128, 0.3);
  background: var(--surface-2, #161f2e);
  transform: translateY(-2px);
}

.card-icon {
  width: 52px;
  height: 52px;
  border-radius: 10px;
  background: rgba(74, 222, 128, 0.08);
  border: 1px solid rgba(74, 222, 128, 0.15);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--green, #4ade80);
}

.card-body h3 {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 15px;
  font-weight: 600;
  color: var(--text, #e2e8f0);
  margin: 0 0 6px;
}

.card-body p {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-muted, #64748b);
  margin: 0;
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid var(--border-muted, rgba(255,255,255,0.04));
}

.card-status {
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 11px;
  color: var(--green, #4ade80);
  opacity: 0.7;
}

.card-status.loading {
  opacity: 0.4;
}

.card-footer svg {
  color: var(--green, #4ade80);
  opacity: 0.5;
  transition: opacity 0.2s, transform 0.2s;
}

.labs-card:hover .card-footer svg {
  opacity: 0.9;
  transform: translateX(3px);
}
</style>
