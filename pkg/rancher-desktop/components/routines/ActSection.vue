<template>
  <!--
    Using <div> rather than <section>/<header> — the app's protocol-dark
    theme has a global `.theme-protocol-dark header { background: #0d1117
    !important }` rule that would paint the act head solid black. Neutral
    tags sidestep it; the hierarchy is still obvious from the markup.
  -->
  <div class="act">
    <div class="head">
      <span class="num">{{ actNum }}</span>
      <span class="title">{{ title }}</span>
      <span class="count">{{ countLabel }}</span>
    </div>
    <slot />
  </div>
</template>

<script setup lang="ts">
defineProps<{
  actNum:     string;
  title:      string;
  countLabel: string;
}>();
</script>

<style scoped lang="scss">
.act { margin-bottom: 8px; }

.head {
  display: flex;
  align-items: baseline;
  gap: 16px;
  margin: 44px 0 18px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
}
.num {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.3em;
  color: var(--steel-300);
  text-transform: uppercase;
}
.title {
  font-family: var(--serif);
  font-style: italic;
  font-size: 24px;
  color: white;
  flex: 1;
}
.count {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--steel-400);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

:global(.theme-noir) .act {
  margin-bottom: 14px;
}

:global(.theme-noir) .head {
  gap: 12px;
  margin: 34px 0 14px;
  padding: 0 4px 11px;
  border-color: var(--nx-hair);
}

:global(.theme-noir) .num {
  color: var(--nx-accent-2);
  letter-spacing: 0.14em;
}

:global(.theme-noir) .title {
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 25px;
  font-style: normal;
  color: var(--nx-read-1);
}

:global(.theme-noir) .count {
  color: var(--nx-read-4);
}
</style>
