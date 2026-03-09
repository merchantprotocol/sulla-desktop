<template>
  <div class="tw-pane" :class="{ dark: isDark }">
    <div class="tw-header" :class="{ dark: isDark }">
      <span class="tw-header-title">Training Wizard</span>
      <div class="tw-header-actions">
        <button class="tw-header-btn" :class="{ dark: isDark }" title="Close Panel" @click="$emit('close')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>

    <div class="tw-steps">
      <!-- ─── Wizard 1: Create Training Data ─── -->
      <div class="tw-section-title" :class="{ dark: isDark, active: currentStep <= 2 }">Create Training Data</div>
      <div
        v-for="(step, idx) in dataSteps"
        :key="'d-' + idx"
        class="tw-step"
        :class="{
          dark: isDark,
          active: currentStep === idx,
          completed: idx < currentStep && currentStep <= 2,
          clickable: idx < currentStep || idx === 0,
        }"
        @click="goToStep(idx)"
      >
        <div class="tw-step-indicator" :class="{ active: currentStep === idx, completed: idx < currentStep && currentStep <= 2 }">
          <svg v-if="idx < currentStep && currentStep <= 2" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span v-else>{{ idx + 1 }}</span>
        </div>
        <div class="tw-step-content">
          <div class="tw-step-title">{{ step.title }}</div>
          <div class="tw-step-desc">{{ step.description }}</div>
        </div>
        <div v-if="idx < dataSteps.length - 1" class="tw-step-connector" :class="{ completed: idx < currentStep && currentStep <= 2 }" />
      </div>

      <!-- ─── Wizard 2: Train Model ─── -->
      <div class="tw-section-title" :class="{ dark: isDark, active: currentStep >= 3 }" style="margin-top: 16px;">Train Model</div>
      <div
        v-for="(step, localIdx) in trainSteps"
        :key="'t-' + localIdx"
        class="tw-step"
        :class="{
          dark: isDark,
          active: currentStep === localIdx + 3,
          completed: localIdx + 3 < currentStep,
          clickable: localIdx + 3 < currentStep || localIdx === 0,
        }"
        @click="goToStep(localIdx + 3)"
      >
        <div class="tw-step-indicator" :class="{ active: currentStep === localIdx + 3, completed: localIdx + 3 < currentStep }">
          <svg v-if="localIdx + 3 < currentStep" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span v-else>{{ localIdx + 1 }}</span>
        </div>
        <div class="tw-step-content">
          <div class="tw-step-title">{{ step.title }}</div>
          <div class="tw-step-desc">{{ step.description }}</div>
        </div>
        <div v-if="localIdx < trainSteps.length - 1" class="tw-step-connector" :class="{ completed: localIdx + 3 < currentStep }" />
      </div>
    </div>

    <!-- Bottom info -->
    <div class="tw-footer" :class="{ dark: isDark }">
      <div class="tw-footer-text" v-if="currentStep <= 2">
        Create Data — Step {{ currentStep + 1 }} of 3
      </div>
      <div class="tw-footer-text" v-else>
        Train Model — Step {{ currentStep - 2 }} of 3
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

interface WizardStep {
  title: string;
  description: string;
}

export default defineComponent({
  name: 'TrainingFileTreePane',

  props: {
    isDark:      { type: Boolean, default: false },
    currentStep: { type: Number, default: 0 },
  },

  emits: ['close', 'step-change'],

  setup(props, { emit }) {
    const dataSteps: WizardStep[] = [
      {
        title: 'Select Documents',
        description: 'Pick folders and files for training data',
      },
      {
        title: 'Craft Prompt',
        description: 'Write or choose a prompt template for data generation',
      },
      {
        title: 'Generate Data',
        description: 'Choose an LLM to generate training examples from your docs',
      },
    ];

    const trainSteps: WizardStep[] = [
      {
        title: 'Select Data Files',
        description: 'Choose which training data files to use',
      },
      {
        title: 'Model & Settings',
        description: 'Choose base model, learning rate, LoRA rank',
      },
      {
        title: 'Train & Deploy',
        description: 'Run LoRA fine-tune and output your custom model',
      },
    ];

    function goToStep(idx: number) {
      if (idx === props.currentStep) return;
      // First step of each wizard is always accessible
      if (idx === 0 || idx === 3 || idx < props.currentStep) {
        emit('step-change', idx);
      }
    }

    return { dataSteps, trainSteps, goToStep };
  },
});
</script>

<style>
.tw-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.tw-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
}
.tw-header.dark {
  border-bottom-color: #334155;
}
.tw-header-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
}
.tw-header.dark .tw-header-title {
  color: #94a3b8;
}
.tw-header-actions {
  display: flex;
  gap: 2px;
}
.tw-header-btn {
  background: none;
  border: none;
  padding: 3px;
  border-radius: 4px;
  cursor: pointer;
  color: #64748b;
  display: flex;
  align-items: center;
}
.tw-header-btn:hover {
  background: #f1f5f9;
  color: #0f172a;
}
.tw-header-btn.dark:hover {
  background: #1e293b;
  color: #e2e8f0;
}

/* Steps */
.tw-steps {
  flex: 1;
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow-y: auto;
}

/* Section titles */
.tw-section-title {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #94a3b8;
  padding: 4px 8px 8px;
}
.tw-section-title.dark {
  color: #64748b;
}
.tw-section-title.active {
  color: #0284c7;
}
.dark .tw-section-title.active {
  color: #38bdf8;
}

.tw-step {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 8px;
  border-radius: 6px;
  cursor: default;
  transition: background 0.15s;
}
.tw-step.clickable {
  cursor: pointer;
}
.tw-step.clickable:hover {
  background: #f1f5f9;
}
.tw-step.clickable.dark:hover {
  background: #1e293b;
}
.tw-step.active {
  background: #eff6ff;
}
.tw-step.active.dark {
  background: #1e293b;
}

/* Step indicator circle */
.tw-step-indicator {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  flex-shrink: 0;
  border: 2px solid #cbd5e1;
  color: #94a3b8;
  background: #fff;
  transition: all 0.2s;
}
.dark .tw-step-indicator {
  border-color: #475569;
  color: #64748b;
  background: #0f172a;
}
.tw-step-indicator.active {
  border-color: #0284c7;
  color: #0284c7;
  background: #fff;
  box-shadow: 0 0 0 3px rgba(2, 132, 199, 0.15);
}
.dark .tw-step-indicator.active {
  border-color: #38bdf8;
  color: #38bdf8;
  background: #0f172a;
  box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.15);
}
.tw-step-indicator.completed {
  border-color: #16a34a;
  background: #16a34a;
  color: #fff;
}
.dark .tw-step-indicator.completed {
  border-color: #22c55e;
  background: #22c55e;
  color: #fff;
}

/* Step content */
.tw-step-content {
  flex: 1;
  min-width: 0;
  padding-top: 2px;
}
.tw-step-title {
  font-size: 13px;
  font-weight: 600;
  color: #334155;
  line-height: 1.3;
}
.dark .tw-step-title {
  color: #e2e8f0;
}
.tw-step.active .tw-step-title {
  color: #0284c7;
}
.dark .tw-step.active .tw-step-title {
  color: #38bdf8;
}
.tw-step.completed .tw-step-title {
  color: #16a34a;
}
.dark .tw-step.completed .tw-step-title {
  color: #4ade80;
}

.tw-step-desc {
  font-size: 11px;
  color: #94a3b8;
  line-height: 1.4;
  margin-top: 2px;
}
.dark .tw-step-desc {
  color: #64748b;
}

/* Connector line between steps */
.tw-step-connector {
  position: absolute;
  left: 21px;
  bottom: -8px;
  width: 2px;
  height: 16px;
  background: #cbd5e1;
  z-index: 0;
}
.dark .tw-step-connector {
  background: #475569;
}
.tw-step-connector.completed {
  background: #16a34a;
}
.dark .tw-step-connector.completed {
  background: #22c55e;
}

/* Footer */
.tw-footer {
  padding: 10px 12px;
  border-top: 1px solid #e5e7eb;
  flex-shrink: 0;
}
.tw-footer.dark {
  border-top-color: #334155;
}
.tw-footer-text {
  font-size: 11px;
  color: #94a3b8;
  text-align: center;
}
</style>
