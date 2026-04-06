<template>
  <div class="add-popup-overlay" :class="{ open: visible }">
    <div class="add-popup">
      <div class="popup-header">
        <h3>{{ addStep === 'type' ? 'Add Source' : 'Choose ' + (selectedAddType ? selectedAddType.charAt(0).toUpperCase() + selectedAddType.slice(1) : '') }}</h3>
        <button class="popup-close" @click="$emit('close')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <!-- Step 1: type -->
      <div v-if="addStep === 'type'" class="type-grid">
        <div
          v-for="t in sourceTypes"
          :key="t.id"
          class="type-card"
          @click="selectAddType(t.id)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" v-html="t.icon"></svg>
          <span>{{ t.label }}</span>
        </div>
      </div>

      <!-- Step 2: device -->
      <div v-if="addStep === 'device'" class="device-step visible">
        <label>{{ addDeviceLabel }}</label>
        <select class="device-select" v-model="selectedDevice">
          <option v-for="d in deviceOptions[selectedAddType!] || []" :key="d" :value="d">{{ d }}</option>
        </select>
        <label>Label (optional)</label>
        <input class="device-label-input" v-model="sourceLabel" :placeholder="selectedAddType === 'system' ? 'e.g. System' : 'e.g. Guest ' + (selectedAddType || '')" />
      </div>

      <div v-if="addStep === 'device'" class="popup-actions">
        <button class="popup-btn secondary" @click="addStep = 'type'">Back</button>
        <button class="popup-btn primary" @click="confirmAdd">Add Source</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

const props = defineProps<{
  visible: boolean;
  deviceOptions: Record<string, string[]>;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'add-source', payload: { type: string; deviceId: string; label: string }): void;
}>();

const addStep = ref<'type' | 'device'>('type');
const selectedAddType = ref<string | null>(null);
const selectedDevice = ref('');
const sourceLabel = ref('');

const sourceTypes = [
  { id: 'screen', label: 'Screen / Window', icon: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>' },
  { id: 'camera', label: 'Camera', icon: '<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>' },
  { id: 'mic', label: 'Microphone', icon: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/>' },
  { id: 'system', label: 'System Audio', icon: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>' },
];

const addDeviceLabel = computed(() => {
  if (selectedAddType.value === 'screen') return 'Screen or window';
  if (selectedAddType.value === 'camera') return 'Camera device';
  if (selectedAddType.value === 'mic') return 'Microphone device';
  return 'Audio source';
});

function selectAddType(type: string) {
  selectedAddType.value = type;
  selectedDevice.value = (props.deviceOptions[type] || [])[0] || '';
  sourceLabel.value = '';
  addStep.value = 'device';
}

function confirmAdd() {
  if (!selectedAddType.value) return;
  const device = selectedDevice.value;
  const label = sourceLabel.value || device.split(' — ')[0].split('(')[0].trim();

  emit('add-source', {
    type: selectedAddType.value,
    deviceId: device,
    label,
  });

  // Reset state
  addStep.value = 'type';
  selectedAddType.value = null;
}
</script>
