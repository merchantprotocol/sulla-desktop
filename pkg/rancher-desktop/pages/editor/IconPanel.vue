<template>
  <div class="icon-panel" :class="{ dark: isDark }">
    <button class="icon-btn" :class="{ active: leftPaneVisible && !searchMode && !gitMode && !dockerMode && !agentMode && !integrationsMode && !workflowMode && !trainingMode }" @click="toggleFileTree">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
        <polyline points="9,22 9,12 15,12 15,22"></polyline>
      </svg>
    </button>
    <button class="icon-btn" :class="{ active: searchMode }" @click="toggleSearch">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/>
        <path d="m21 21-4.35-4.35"/>
      </svg>
    </button>
    <button class="icon-btn" :class="{ active: gitMode }" @click="toggleGit">
      <svg width="21" height="21" viewBox="0 0 98 96" fill="currentColor">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.336-3.015.336-3.015 4.923.35 7.516 5.052 7.516 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.57 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 22.933-22.243 24.283 1.78 1.348 3.16 3.015 3.16 6.6 0 9.633-.08 17.45-.08 19.85 0 1.304.965 2.373 2.372 2.373 2.362 0 4.923-1.059 3.316-2.362C95.76 89.346 109.708 70.973 109.708 49.217 109.708 22 87.868 0 60.854 0h-12z"/>
      </svg>
    </button>
    <button class="icon-btn" :class="{ active: dockerMode }" @click="toggleDocker">
      <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor">
        <path d="M13.983 11.078h2.119a.186.186 0 0 0 .186-.185V9.006a.186.186 0 0 0-.186-.186h-2.119a.186.186 0 0 0-.187.186v1.887c0 .102.084.185.187.185m-2.954-5.43h2.118a.186.186 0 0 0 .187-.186V3.574a.186.186 0 0 0-.187-.186h-2.118a.186.186 0 0 0-.187.186v1.888c0 .102.085.185.187.185m0 2.716h2.118a.187.187 0 0 0 .187-.186V6.29a.186.186 0 0 0-.187-.186h-2.118a.186.186 0 0 0-.187.186v1.887c0 .102.085.186.187.186m-2.93 0h2.12a.186.186 0 0 0 .186-.186V6.29a.186.186 0 0 0-.187-.186H8.1a.186.186 0 0 0-.185.186v1.887c0 .102.083.186.185.186m-2.964 0h2.119a.186.186 0 0 0 .185-.186V6.29a.186.186 0 0 0-.185-.186H5.136a.186.186 0 0 0-.186.186v1.887c0 .102.084.186.186.186m5.893 2.715h2.118a.186.186 0 0 0 .186-.185V9.006a.186.186 0 0 0-.186-.186h-2.118a.187.187 0 0 0-.187.186v1.887c0 .102.085.185.187.185m-2.93 0h2.12a.185.185 0 0 0 .185-.185V9.006a.186.186 0 0 0-.185-.186h-2.12a.186.186 0 0 0-.184.186v1.887c0 .102.083.185.185.185m-2.964 0h2.119a.186.186 0 0 0 .185-.185V9.006a.186.186 0 0 0-.185-.186H5.136a.186.186 0 0 0-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 0 0 .184-.185V9.006a.186.186 0 0 0-.184-.186h-2.12a.186.186 0 0 0-.186.186v1.887c0 .102.084.185.186.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 0 0-.75.748 11.376 11.376 0 0 0 .692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 0 0 3.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z"/>
      </svg>
    </button>

    <button class="icon-btn" :class="{ active: agentMode }" @click="$emit('toggle-agent')" title="Agent">
      <img :src="logoUrl" class="icon-logo" alt="Agent" />
    </button>
    <button class="icon-btn" :class="{ active: integrationsMode }" @click="$emit('toggle-integrations')" title="Integrations">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 6h16M4 12h16M4 18h16"/>
        <circle cx="8" cy="6" r="1.5" fill="currentColor" stroke="none"/>
        <circle cx="16" cy="12" r="1.5" fill="currentColor" stroke="none"/>
        <circle cx="10" cy="18" r="1.5" fill="currentColor" stroke="none"/>
        <path d="M8 6h8M8 12h8M10 18h6"/>
      </svg>
    </button>
    <button class="icon-btn" :class="{ active: workflowMode }" @click="$emit('toggle-workflow')" title="Agent Workflows">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="3" width="6" height="5" rx="1"/>
        <rect x="16" y="3" width="6" height="5" rx="1"/>
        <rect x="9" y="16" width="6" height="5" rx="1"/>
        <path d="M5 8v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/>
        <line x1="12" y1="12" x2="12" y2="16"/>
      </svg>
    </button>
    <button class="icon-btn" :class="{ active: trainingMode }" @click="$emit('toggle-training')" title="Model Training">
      <img :src="gearBrainUrl" class="icon-logo" alt="Training" />
    </button>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed } from 'vue';

export default defineComponent({
  name: 'IconPanel',

  props: {
    isDark: { type: Boolean, default: false },
    leftPaneVisible: { type: Boolean, default: true },
    searchMode: { type: Boolean, default: false },
    gitMode: { type: Boolean, default: false },
    dockerMode: { type: Boolean, default: false },
    agentMode: { type: Boolean, default: false },
    integrationsMode: { type: Boolean, default: false },
    workflowMode: { type: Boolean, default: false },
    trainingMode: { type: Boolean, default: false },
  },

  emits: [
    'toggle-file-tree',
    'toggle-search',
    'toggle-git',
    'toggle-docker',
    'toggle-agent',
    'toggle-integrations',
    'toggle-workflow',
    'toggle-training',
  ],

  setup(_props, { emit }) {
    const logoUrl = computed(() => {
      return new URL('../../../../resources/icons/robot-512-nobg.png', import.meta.url).href;
    });
    const gearBrainUrl = computed(() => {
      return new URL('../../../../resources/icons/gear-brain.svg', import.meta.url).href;
    });

    function toggleFileTree() { emit('toggle-file-tree'); }
    function toggleSearch() { emit('toggle-search'); }
    function toggleGit() { emit('toggle-git'); }
    function toggleDocker() { emit('toggle-docker'); }

    return {
      logoUrl,
      gearBrainUrl,
      toggleFileTree,
      toggleSearch,
      toggleGit,
      toggleDocker,
    };
  }
});
</script>

<style scoped>
.icon-panel {
  width: 45px;
  flex-shrink: 0;
  background: #f8fafc;
  border-right: 1px solid #e2e8f0;
  display: flex;
  flex-direction: column;
  padding: 8px 0;
  gap: 9px;
}

.icon-panel.dark {
  background: #1e293b;
  border-right-color: #334155;
}

.icon-btn {
  width: 45px;
  height: 45px;
  border: none;
  background: transparent;
  color: #64748b;
  border-radius: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
  position: relative;
}

.icon-btn:hover {
  background: rgba(0, 0, 0, 0.05);
  color: #334155;
}

.icon-btn.active {
  background: rgba(0, 0, 0, 0.1);
  color: #0078d4;
}

.dark .icon-btn {
  color: #94a3b8;
}

.dark .icon-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  color: #cbd5e1;
}

.dark .icon-btn.active {
  background: rgba(255, 255, 255, 0.1);
  color: #0078d4;
}

.icon-btn svg {
  width: 21px;
  height: 21px;
}

.icon-btn.active::after {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: #0078d4;
  border-top-right-radius: 3px;
  border-bottom-right-radius: 3px;
}

.icon-logo {
  width: 21px;
  height: 21px;
  opacity: 0.6;
}

.icon-btn:hover .icon-logo {
  opacity: 0.8;
}

.icon-btn.active .icon-logo {
  opacity: 1;
}

.dark .icon-logo {
  filter: invert(1);
  opacity: 0.5;
}

.dark .icon-btn:hover .icon-logo {
  opacity: 0.7;
}

.dark .icon-btn.active .icon-logo {
  opacity: 0.9;
}
</style>
