<script lang="ts">

import { defineComponent } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export default defineComponent({
  name:  'help',
  props: {
    url: {
      type:    String,
      default: null,
    },
    tooltip: {
      type:    String,
      default: null,
    },
    disabled: {
      type:    Boolean,
      default: false,
    },
  },
  methods: {
    openUrl() {
      if (!this.disabled) {
        if (this.url) {
          ipcRenderer.send('open-url-in-app', this.url);
        } else {
          this.$emit('open:url');
        }
      }
    },
  },
});
</script>

<template>
  <div class="help-button">
    <i
      v-tooltip="{
        content: tooltip,
        placement: 'left',
      }"
      class="icon icon-question-mark"
      :class="{
        disabled,
      }"
      @click="openUrl"
    />
  </div>
</template>

<style lang="scss" scoped>

  .help-button {

    .icon {
      background: transparent;
      color: var(--primary);
      font-size: var(--fs-heading);
      cursor: pointer;

      &:hover {
        color: var(--primary-hover-bg);
      }
    }

    .disabled {
      background: transparent !important;
      color: var(--body-text);
      opacity: 0.2;
      cursor: default;

      &:hover {
        color: var(--body-text);
      }
    }
  }
</style>
