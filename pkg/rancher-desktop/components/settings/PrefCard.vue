<script setup lang="ts">
defineProps<{
  title:     string;
  subtitle?: string;
  /** Dims the card's rows when the feature they belong to is off. */
  off?:      boolean;
}>();
</script>

<template>
  <section
    class="card"
    :class="{ off }"
  >
    <div class="card-h">
      <div>
        <h2>{{ title }}</h2>
        <p v-if="subtitle || $slots.subtitle">
          <slot name="subtitle">
            {{ subtitle }}
          </slot>
        </p>
      </div>
      <div
        v-if="$slots.actions"
        class="r"
      >
        <slot name="actions" />
      </div>
    </div>
    <slot />
  </section>
</template>
