<template>
  <div
    class="trigger-config"
    :class="{ dark: isDark }"
  >
    <!-- Schedule-specific fields -->
    <template v-if="config.triggerType === 'schedule'">
      <!-- Frequency -->
      <div class="node-field">
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >Run this workflow</label>
        <select
          class="node-field-input"
          :class="{ dark: isDark }"
          :value="config.frequency || 'daily'"
          @change="updateField('frequency', ($event.target as HTMLSelectElement).value)"
        >
          <option value="every-minutes">
            Every X minutes
          </option>
          <option value="hourly">
            Every hour
          </option>
          <option value="daily">
            Every day
          </option>
          <option value="weekly">
            Every week
          </option>
          <option value="monthly">
            Every month
          </option>
        </select>
      </div>

      <!-- Interval minutes (only for every-minutes) -->
      <div
        v-if="config.frequency === 'every-minutes'"
        class="node-field"
      >
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >Every</label>
        <div class="inline-field">
          <select
            class="node-field-input inline-select"
            :class="{ dark: isDark }"
            :value="config.intervalMinutes || 15"
            @change="updateField('intervalMinutes', Number(($event.target as HTMLSelectElement).value))"
          >
            <option :value="5">
              5
            </option>
            <option :value="10">
              10
            </option>
            <option :value="15">
              15
            </option>
            <option :value="30">
              30
            </option>
            <option :value="45">
              45
            </option>
          </select>
          <span
            class="inline-label"
            :class="{ dark: isDark }"
          >minutes</span>
        </div>
      </div>

      <!-- Minute (for hourly) -->
      <div
        v-if="config.frequency === 'hourly'"
        class="node-field"
      >
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >At minute</label>
        <select
          class="node-field-input"
          :class="{ dark: isDark }"
          :value="config.minute ?? 0"
          @change="updateField('minute', Number(($event.target as HTMLSelectElement).value))"
        >
          <option
            v-for="m in minuteOptions"
            :key="m.value"
            :value="m.value"
          >
            {{ m.label }}
          </option>
        </select>
      </div>

      <!-- Time of day (for daily/weekly/monthly) -->
      <div
        v-if="config.frequency === 'daily' || config.frequency === 'weekly' || config.frequency === 'monthly'"
        class="node-field"
      >
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >At time</label>
        <div class="inline-field">
          <select
            class="node-field-input inline-select"
            :class="{ dark: isDark }"
            :value="config.hour ?? 9"
            @change="updateField('hour', Number(($event.target as HTMLSelectElement).value))"
          >
            <option
              v-for="h in hourOptions"
              :key="h.value"
              :value="h.value"
            >
              {{ h.label }}
            </option>
          </select>
          <span
            class="inline-label"
            :class="{ dark: isDark }"
          >:</span>
          <select
            class="node-field-input inline-select"
            :class="{ dark: isDark }"
            :value="config.minute ?? 0"
            @change="updateField('minute', Number(($event.target as HTMLSelectElement).value))"
          >
            <option
              v-for="m in minuteOptions"
              :key="m.value"
              :value="m.value"
            >
              {{ m.label }}
            </option>
          </select>
        </div>
      </div>

      <!-- Day of week (for weekly) -->
      <div
        v-if="config.frequency === 'weekly'"
        class="node-field"
      >
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >On</label>
        <select
          class="node-field-input"
          :class="{ dark: isDark }"
          :value="config.dayOfWeek ?? 1"
          @change="updateField('dayOfWeek', Number(($event.target as HTMLSelectElement).value))"
        >
          <option :value="0">
            Sunday
          </option>
          <option :value="1">
            Monday
          </option>
          <option :value="2">
            Tuesday
          </option>
          <option :value="3">
            Wednesday
          </option>
          <option :value="4">
            Thursday
          </option>
          <option :value="5">
            Friday
          </option>
          <option :value="6">
            Saturday
          </option>
        </select>
      </div>

      <!-- Day of month (for monthly) -->
      <div
        v-if="config.frequency === 'monthly'"
        class="node-field"
      >
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >On day</label>
        <select
          class="node-field-input"
          :class="{ dark: isDark }"
          :value="config.dayOfMonth ?? 1"
          @change="updateField('dayOfMonth', Number(($event.target as HTMLSelectElement).value))"
        >
          <option
            v-for="d in 31"
            :key="d"
            :value="d"
          >
            {{ d }}{{ ordinalSuffix(d) }}
          </option>
        </select>
      </div>

      <!-- Timezone -->
      <div class="node-field">
        <label
          class="node-field-label"
          :class="{ dark: isDark }"
        >Timezone</label>
        <input
          class="node-field-input"
          :class="{ dark: isDark }"
          :placeholder="systemTimezone"
          :value="config.timezone || ''"
          @input="updateField('timezone', ($event.target as HTMLInputElement).value)"
        >
        <p
          class="help-text field-hint"
          :class="{ dark: isDark }"
        >
          Leave empty to use your system timezone ({{ systemTimezone }})
        </p>
      </div>

      <!-- Schedule summary -->
      <div class="node-field">
        <p
          class="schedule-summary"
          :class="{ dark: isDark }"
        >
          {{ scheduleSummary }}
        </p>
      </div>
    </template>

    <div class="node-field">
      <label
        class="node-field-label"
        :class="{ dark: isDark }"
      >Trigger Description</label>
      <textarea
        class="node-field-input node-field-textarea"
        :class="{ dark: isDark }"
        rows="3"
        placeholder="e.g. This workflow handles customer support questions about billing and refunds"
        :value="config.triggerDescription || ''"
        @input="updateField('triggerDescription', ($event.target as HTMLTextAreaElement).value)"
      />
    </div>
    <div class="node-field help-section">
      <p
        class="help-text"
        :class="{ dark: isDark }"
      >
        This description is used by the workflow registry to determine if an incoming
        message should trigger this workflow. Be specific about what kinds of messages
        or events this workflow should handle.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  isDark: boolean;
  nodeId: string;
  config: Record<string, any>;
}>();

const emit = defineEmits<{
  'update-config': [nodeId: string, config: Record<string, any>];
}>();

function updateField(field: string, value: any) {
  emit('update-config', props.nodeId, { ...props.config, [field]: value });
}

const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const hourOptions = Array.from({ length: 24 }, (_, i) => {
  const ampm = i < 12 ? 'AM' : 'PM';
  const h12 = i === 0 ? 12 : i > 12 ? i - 12 : i;

  return { value: i, label: `${ h12 } ${ ampm }` };
});

const minuteOptions = Array.from({ length: 12 }, (_, i) => {
  const m = i * 5;

  return { value: m, label: String(m).padStart(2, '0') };
});

function ordinalSuffix(n: number): string {
  if (n >= 11 && n <= 13) return 'th';
  switch (n % 10) {
  case 1: return 'st';
  case 2: return 'nd';
  case 3: return 'rd';
  default: return 'th';
  }
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const scheduleSummary = computed(() => {
  const freq = props.config.frequency || 'daily';
  const h = props.config.hour ?? 9;
  const m = props.config.minute ?? 0;
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const timeStr = `${ h12 }:${ String(m).padStart(2, '0') } ${ ampm }`;
  const tz = props.config.timezone || systemTimezone;

  switch (freq) {
  case 'every-minutes':
    return `Runs every ${ props.config.intervalMinutes || 15 } minutes (${ tz })`;
  case 'hourly':
    return `Runs every hour at :${ String(m).padStart(2, '0') } (${ tz })`;
  case 'daily':
    return `Runs every day at ${ timeStr } (${ tz })`;
  case 'weekly':
    return `Runs every ${ DAYS[props.config.dayOfWeek ?? 1] } at ${ timeStr } (${ tz })`;
  case 'monthly':
    return `Runs on the ${ props.config.dayOfMonth ?? 1 }${ ordinalSuffix(props.config.dayOfMonth ?? 1) } of every month at ${ timeStr } (${ tz })`;
  default:
    return '';
  }
});
</script>

<style scoped>
.trigger-config { padding: 0; }

.node-field {
  padding: 12px;
  border-bottom: 1px solid var(--border-default);
}

.node-field-label {
  display: block;
  font-size: var(--fs-caption);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wider);
  color: var(--text-secondary);
  margin-bottom: 6px;
}
.node-field-label.dark { color: var(--text-muted); }

.node-field-input {
  width: 100%;
  padding: 6px 8px;
  font-size: var(--fs-code);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: var(--bg-surface);
  color: var(--text-primary);
  outline: none;
  box-sizing: border-box;
}
.node-field-input:focus {
  border-color: var(--border-accent);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
}

select.node-field-input {
  cursor: pointer;
  appearance: auto;
}

.node-field-textarea {
  resize: vertical;
  font-family: inherit;
  min-height: 60px;
}

.inline-field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.inline-select {
  width: auto;
  min-width: 70px;
}

.inline-label {
  font-size: var(--fs-code);
  color: var(--text-secondary);
}
.inline-label.dark { color: var(--text-muted); }

.field-hint {
  margin-top: 4px;
  margin-bottom: 0;
}

.schedule-summary {
  font-size: var(--fs-code);
  font-weight: var(--weight-medium);
  color: var(--accent-primary);
  margin: 0;
  padding: 8px 10px;
  background: var(--bg-accent);
  border-radius: 4px;
  line-height: 1.4;
}
.schedule-summary.dark {
  color: var(--accent-primary);
}

.help-section { border-bottom: none; }

.help-text {
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  margin: 0 0 6px;
  line-height: 1.5;
}
.help-text:last-child { margin-bottom: 0; }
.help-text.dark { color: var(--text-secondary); }
</style>
