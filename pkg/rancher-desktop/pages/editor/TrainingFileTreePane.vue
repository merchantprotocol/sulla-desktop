<template>
  <div
    class="tw-pane"
    :class="{ dark: isDark }"
  >
    <div
      class="tw-header"
      :class="{ dark: isDark }"
    >
      <span class="tw-header-title">Training Wizard</span>
      <div class="tw-header-actions">
        <button
          class="tw-header-btn"
          :class="{ dark: isDark }"
          title="Close Panel"
          @click="$emit('close')"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line
              x1="18"
              y1="6"
              x2="6"
              y2="18"
            />
            <line
              x1="6"
              y1="6"
              x2="18"
              y2="18"
            />
          </svg>
        </button>
      </div>
    </div>

    <div class="tw-steps">
      <!-- ─── Dashboard link ─── -->
      <div
        class="tw-dashboard-link"
        :class="{ dark: isDark, active: currentStep === -1 }"
        @click="goToStep(-1)"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect
            x="3"
            y="3"
            width="7"
            height="7"
          />
          <rect
            x="14"
            y="3"
            width="7"
            height="7"
          />
          <rect
            x="14"
            y="14"
            width="7"
            height="7"
          />
          <rect
            x="3"
            y="14"
            width="7"
            height="7"
          />
        </svg>
        <span>Dashboard</span>
      </div>

      <!-- ─── Wizard 1: Create Training Data ─── -->
      <div
        class="tw-section-title"
        :class="{ dark: isDark, active: currentStep >= 0 && currentStep <= 2 }"
      >
        Create Training Data
      </div>
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
        <div
          class="tw-step-indicator"
          :class="{ active: currentStep === idx, completed: idx < currentStep && currentStep <= 2 }"
        >
          <svg
            v-if="idx < currentStep && currentStep <= 2"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span v-else>{{ idx + 1 }}</span>
        </div>
        <div class="tw-step-content">
          <div class="tw-step-title">
            {{ step.title }}
          </div>
          <div class="tw-step-desc">
            {{ step.description }}
          </div>
        </div>
        <div
          v-if="idx < dataSteps.length - 1"
          class="tw-step-connector"
          :class="{ completed: idx < currentStep && currentStep <= 2 }"
        />
      </div>

      <!-- ─── Wizard 2: Train Model ─── -->
      <div
        class="tw-section-title"
        :class="{ dark: isDark, active: currentStep >= 3 }"
        style="margin-top: 16px;"
      >
        Train Model
      </div>
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
        <div
          class="tw-step-indicator"
          :class="{ active: currentStep === localIdx + 3, completed: localIdx + 3 < currentStep }"
        >
          <svg
            v-if="localIdx + 3 < currentStep"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span v-else>{{ localIdx + 1 }}</span>
        </div>
        <div class="tw-step-content">
          <div class="tw-step-title">
            {{ step.title }}
          </div>
          <div class="tw-step-desc">
            {{ step.description }}
          </div>
        </div>
        <div
          v-if="localIdx < trainSteps.length - 1"
          class="tw-step-connector"
          :class="{ completed: localIdx + 3 < currentStep }"
        />
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

interface WizardStep {
  title:       string;
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
        title:       'Select Documents',
        description: 'Pick folders and files for training data',
      },
      {
        title:       'Craft Prompt',
        description: 'Write or choose a prompt template for data generation',
      },
      {
        title:       'Generate Data',
        description: 'Choose an LLM to generate training examples from your docs',
      },
    ];

    const trainSteps: WizardStep[] = [
      {
        title:       'Select Data Files',
        description: 'Choose which training data files to use',
      },
      {
        title:       'Model & Settings',
        description: 'Choose base model, learning rate, LoRA rank',
      },
      {
        title:       'Train & Deploy',
        description: 'Run LoRA fine-tune and output your custom model',
      },
    ];

    function goToStep(idx: number) {
      if (idx === props.currentStep) return;
      // Dashboard is always accessible, first step of each wizard is always accessible
      if (idx === -1 || idx === 0 || idx === 3 || idx < props.currentStep) {
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
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.tw-header-title {
  font-size: var(--fs-body-sm);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
  color: var(--text-secondary);
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
  color: var(--text-secondary);
  display: flex;
  align-items: center;
}
.tw-header-btn:hover {
  background: var(--bg-surface-alt);
  color: var(--text-primary);
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
  font-size: var(--fs-caption);
  font-weight: var(--weight-bold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wider);
  color: var(--text-muted);
  padding: 4px 8px 8px;
}
.tw-section-title.active {
  color: var(--accent-primary);
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
  background: var(--bg-surface-alt);
}
.tw-step.active {
  background: var(--bg-info);
}

/* Step indicator circle */
.tw-step-indicator {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-body-sm);
  font-weight: var(--weight-bold);
  flex-shrink: 0;
  border: 2px solid var(--border-strong);
  color: var(--text-muted);
  background: var(--bg-surface);
  transition: all 0.2s;
}
.tw-step-indicator.active {
  border-color: var(--border-accent);
  color: var(--accent-primary);
  background: var(--bg-surface);
  box-shadow: 0 0 0 3px rgba(2, 132, 199, 0.15);
}
.tw-step-indicator.completed {
  border-color: var(--border-success);
  background: var(--border-success);
  color: var(--text-on-accent);
}

/* Step content */
.tw-step-content {
  flex: 1;
  min-width: 0;
  padding-top: 2px;
}
.tw-step-title {
  font-size: var(--fs-code);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  line-height: 1.3;
}
.tw-step.active .tw-step-title {
  color: var(--accent-primary);
}
.tw-step.completed .tw-step-title {
  color: var(--text-success);
}

.tw-step-desc {
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  line-height: 1.4;
  margin-top: 2px;
}

/* Connector line between steps */
.tw-step-connector {
  position: absolute;
  left: 21px;
  bottom: -8px;
  width: 2px;
  height: 16px;
  background: var(--border-strong);
  z-index: 0;
}
.tw-step-connector.completed {
  background: var(--border-success);
}

/* Dashboard link */
.tw-dashboard-link {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
  border-radius: 6px;
  font-size: var(--fs-code);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  border-bottom: 1px solid var(--border-default);
}
.tw-dashboard-link:hover {
  background: var(--bg-surface-alt);
}
.tw-dashboard-link.active {
  background: var(--bg-info);
  color: var(--accent-primary);
}
</style>
