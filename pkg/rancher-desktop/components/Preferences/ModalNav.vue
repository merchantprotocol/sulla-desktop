<script lang="ts">
import { defineComponent, type CSSProperties } from 'vue';

import PreferencesNavItem from '@pkg/components/Preferences/ModalNavItem.vue';

export default defineComponent({
  name:       'preferences-nav',
  components: { NavItem: PreferencesNavItem },
  props:      {
    currentNavItem: {
      type:     String,
      required: true,
    },
    navItems: {
      type:     Array,
      required: true,
    },
  },
  data() {
    return {
      noirGlassTop:   0,
      resizeObserver: null as ResizeObserver | null,
    };
  },
  computed: {
    noirGlassStyle(): CSSProperties {
      return { transform: `translateY(${ this.noirGlassTop }px)` };
    },
  },
  watch: {
    currentNavItem() {
      this.$nextTick(this.updateNoirGlass);
    },
  },
  mounted() {
    this.updateNoirGlass();
    this.resizeObserver = new ResizeObserver(this.updateNoirGlass);
    this.resizeObserver.observe(this.$refs.navList as HTMLElement);
    window.addEventListener('resize', this.updateNoirGlass);
  },
  beforeUnmount() {
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.updateNoirGlass);
  },

  methods: {
    navClicked(tabName: string) {
      if (tabName !== this.$props.currentNavItem) {
        this.$emit('nav-changed', tabName);
      }
    },
    navToKebab(navItem: string): string {
      return `nav-${ navItem.toLowerCase().replaceAll(' ', '-') }`;
    },
    updateNoirGlass() {
      const navList = this.$refs.navList as HTMLElement | undefined;
      const currentItem = Array.from(navList?.querySelectorAll<HTMLElement>('.preferences-nav-item') ?? [])
        .find(item => item.dataset.navName === this.currentNavItem);

      if (currentItem) {
        this.noirGlassTop = currentItem.offsetTop;
      }
    },
  },
});
</script>

<template>
  <div class="preferences-nav">
    <div
      ref="navList"
      class="preferences-nav-list"
    >
      <span
        class="preferences-nav-glass"
        :style="noirGlassStyle"
        aria-hidden="true"
      />
      <nav-item
        v-for="navItem in navItems"
        :key="navItem"
        :data-test="navToKebab(navItem)"
        :data-nav-name="navItem"
        :name="navItem"
        :active="currentNavItem === navItem"
        @click="navClicked"
      >
        {{ navItem }}
      </nav-item>
    </div>
    <div class="preferences-nav-status">
      <div><span aria-hidden="true" /> Settings loaded</div>
      <small>Changes apply when you save</small>
    </div>
  </div>
</template>

<style lang="scss" scoped>
  .preferences-nav {
    display: flex;
    flex-direction: column;
    height: 100%;
    border-right: 1px solid var(--border-default, var(--header-border));;
    padding-top: 0.75rem;
  }

  .preferences-nav-list {
    display: contents;
  }

  .preferences-nav-glass,
  .preferences-nav-status {
    display: none;
  }
</style>
