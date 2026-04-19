<template>
  <div
    class="float-controls"
    :class="{ 'tp-hidden': currentLayout === 'teleprompter' }"
  >
    <!-- Default sources -->
    <button
      v-for="src in builtinSources"
      :key="src.id"
      class="src-toggle"
      :class="{ on: src.on, off: !src.on, recording: recording && src.on }"
      :title="src.name"
      @click="$emit('toggle-src', src)"
      @contextmenu.prevent="$emit('source-menu', src, $event)"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        v-html="iconMap[src.type]"
      />
      <div
        v-if="src.on"
        class="active-dot"
      />
      <div
        v-if="src.type === 'mic'"
        class="mic-ring"
      />
      <div
        v-if="src.on && src.isVideo && assign.primary === src.id"
        class="role-indicator primary-role"
      >
        P
      </div>
      <div
        v-else-if="src.on && src.isVideo && assign.pip === src.id && (currentLayout === 'pip' || currentLayout === 'sidebyside')"
        class="role-indicator pip-role"
      >
        2
      </div>
    </button>

    <!-- Custom sources -->
    <button
      v-for="src in customSources"
      :key="src.id"
      class="src-toggle custom"
      :class="{ on: src.on, off: !src.on }"
      :title="src.name"
      @click="$emit('toggle-src', src)"
      @contextmenu.prevent="$emit('source-menu', src, $event)"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        v-html="iconMap[src.type] || iconMap.mic"
      />
      <div
        v-if="src.on"
        class="active-dot"
      />
      <div
        v-if="src.on && src.isVideo && assign.primary === src.id"
        class="role-indicator primary-role"
      >
        P
      </div>
      <div
        v-else-if="src.on && src.isVideo && assign.pip === src.id && (currentLayout === 'pip' || currentLayout === 'sidebyside')"
        class="role-indicator pip-role"
      >
        2
      </div>
    </button>

    <!-- Add source -->
    <button
      class="add-src-btn"
      title="Add source"
      @click="$emit('add-source')"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      ><line
        x1="12"
        y1="5"
        x2="12"
        y2="19"
      /><line
        x1="5"
        y1="12"
        x2="19"
        y2="12"
      /></svg>
    </button>

    <div class="fc-divider" />

    <!-- Prompter toggle -->
    <button
      class="prompter-toggle"
      :class="{ active: prompterEnabled }"
      title="Teleprompter"
      @click="$emit('toggle-prompter')"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      ><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line
        x1="16"
        y1="13"
        x2="8"
        y2="13"
      /><line
        x1="16"
        y1="17"
        x2="8"
        y2="17"
      /><polyline points="10 9 9 9 8 9" /></svg>
      <div class="active-dot" />
    </button>

    <!-- Track panel toggle -->
    <button
      class="track-toggle-btn"
      :class="{ active: tracksOpen }"
      title="Track lanes"
      @click="$emit('toggle-tracks')"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      ><line
        x1="4"
        y1="6"
        x2="20"
        y2="6"
      /><line
        x1="4"
        y1="12"
        x2="20"
        y2="12"
      /><line
        x1="4"
        y1="18"
        x2="20"
        y2="18"
      /><circle
        cx="8"
        cy="6"
        r="2"
        fill="currentColor"
      /><circle
        cx="16"
        cy="12"
        r="2"
        fill="currentColor"
      /><circle
        cx="10"
        cy="18"
        r="2"
        fill="currentColor"
      /></svg>
    </button>

    <!-- Screenshot -->
    <button
      class="screenshot-btn"
      title="Screenshot"
      @click="$emit('screenshot')"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      ><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle
        cx="12"
        cy="13"
        r="4"
      /></svg>
    </button>

    <div class="fc-divider" />

    <span
      class="fc-timer"
      :class="{ visible: recording }"
    >{{ timerDisplay }}</span>
    <button
      class="record-pill"
      :class="{ idle: !recording, active: recording }"
      @click="$emit('toggle-record')"
    >
      <div class="dot" />
      <span>{{ recording ? 'Stop' : 'Record' }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
interface Source {
  id:      string;
  type:    string;
  name:    string;
  color:   string;
  status:  string;
  builtin: boolean;
  on:      boolean;
  isVideo: boolean;
}

defineProps<{
  sources:         Source[];
  builtinSources:  Source[];
  customSources:   Source[];
  recording:       boolean;
  timerDisplay:    string;
  prompterEnabled: boolean;
  tracksOpen:      boolean;
  currentLayout:   string;
  assign:          { primary: string; pip: string };
  iconMap:         Record<string, string>;
}>();

defineEmits<{
  (e: 'toggle-src', src: Source): void;
  (e: 'source-menu', src: Source, event: MouseEvent): void;
  (e: 'toggle-prompter'): void;
  (e: 'toggle-tracks'): void;
  (e: 'screenshot'): void;
  (e: 'toggle-record'): void;
  (e: 'add-source'): void;
}>();
</script>
