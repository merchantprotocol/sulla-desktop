<script lang="ts">
import { defineComponent } from 'vue';
export default defineComponent({
  name:  'preferences-nav-item',
  props: {
    /**
     * Indicates if the nav item is active
     */
    active: {
      type:    Boolean,
      default: false,
    },
    /**
     * The Nav Item name
     */
    name: {
      type:     String,
      required: true,
    },
  },
  emits:   ['click'],
  methods: {
    navClicked() {
      this.$emit('click', this.name);
    },
  },
});
</script>

<template>
  <div
    class="preferences-nav-item"
    :class="{ active }"
    @click="navClicked"
  >
    <slot>Menu Item</slot>
  </div>
</template>

<style lang="scss" scoped>
  .preferences-nav-item {
    font-size: var(--fs-heading);
    line-height: 1.75rem;
    padding: 0.5rem 0.75rem;
    cursor: pointer;
    user-select: none;
    color: var(--text-muted, var(--muted));
    transition: background 0.15s, color 0.15s;
    border-left: 2px solid transparent;

    &:hover {
      background: var(--bg-surface-hover, var(--nav-active));
      color: var(--text-primary, var(--body-text));
    }
  }

  .active {
    background: var(--bg-active, var(--primary-light-bg, rgba(59, 130, 246, 0.05)));
    color: var(--accent-primary, var(--primary, #3b82f6));
    border-left-color: var(--accent-primary, var(--primary, #3b82f6));
    font-weight: 500;
  }
</style>
