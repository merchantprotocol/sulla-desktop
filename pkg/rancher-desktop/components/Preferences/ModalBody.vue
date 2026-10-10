<script lang="ts">

import { defineComponent } from 'vue';
import { mapState } from 'vuex';

import PreferencesBodyAppearance from '@pkg/components/Preferences/BodyAppearance.vue';
import PreferencesBodyApplication from '@pkg/components/Preferences/BodyApplication.vue';
import PreferencesBodyContainerEngine from '@pkg/components/Preferences/BodyContainerEngine.vue';
import PreferencesBodyKubernetes from '@pkg/components/Preferences/BodyKubernetes.vue';
import PreferencesBodyVirtualMachine from '@pkg/components/Preferences/BodyVirtualMachine.vue';
import PreferencesBodyWsl from '@pkg/components/Preferences/BodyWsl.vue';
import PreferencesHelp from '@pkg/components/Preferences/Help.vue';
import { Settings } from '@pkg/config/settings';

import type { PropType } from 'vue';

export default defineComponent({
  name:       'preferences-body',
  components: {
    PreferencesBodyAppearance,
    PreferencesBodyApplication,
    PreferencesBodyVirtualMachine,
    PreferencesBodyWsl,
    PreferencesBodyContainerEngine,
    PreferencesBodyKubernetes,
    PreferencesHelp,
  },
  props: {
    currentNavItem: {
      type:     String,
      required: true,
    },
    preferences: {
      type:     Object as PropType<Settings>,
      required: true,
    },
  },
  computed: {
    ...mapState('credentials', ['credentials']),
    normalizeNavItem(): string {
      return this.currentNavItem.toLowerCase().replaceAll(' ', '-');
    },
    componentFromNavItem(): string {
      return `preferences-body-${ this.normalizeNavItem }`;
    },
    noirSection(): { eyebrow: string, headline: string, lead: string } {
      const sections: Record<string, { eyebrow: string, headline: string, lead: string }> = {
        Application: {
          eyebrow: 'Application',
          headline: 'Make Sulla work your way.',
          lead:     'Control startup, updates, access, and the environment around Sulla Desktop.',
        },
        Appearance: {
          eyebrow: 'Appearance',
          headline: 'Set the mood.',
          lead:     'Choose the visual language Sulla uses across every window.',
        },
        'Virtual Machine': {
          eyebrow: 'Virtual Machine',
          headline: 'Shape the machine underneath.',
          lead:     'Tune the hardware, storage, and emulation that power your local workloads.',
        },
        WSL: {
          eyebrow: 'WSL',
          headline: 'Connect Sulla to Windows.',
          lead:     'Manage distribution integrations and the proxy used by the Linux environment.',
        },
        'Container Engine': {
          eyebrow: 'Container Engine',
          headline: 'Choose how containers run.',
          lead:     'Select the engine and decide which images are allowed on this machine.',
        },
        Kubernetes: {
          eyebrow: 'Kubernetes',
          headline: 'Tune your local cluster.',
          lead:     'Choose the version, port, and services that make up the development cluster.',
        },
      };

      return sections[this.currentNavItem] ?? {
        eyebrow: this.currentNavItem,
        headline: 'Shape how Sulla runs.',
        lead:     'Adjust this part of your local environment.',
      };
    },
  },
  mounted() {
    (this.$root as any).navigate = this.navigate;
  },
  methods: {
    navigate(navItem: string, tab: string) {
      console.log('Navigate!', Array.from(arguments));
      this.$store.dispatch(
        'transientSettings/navigatePrefDialog',
        {
          ...this.credentials,
          navItem,
          tab,
        },
      );
    },
  },
});
</script>

<template>
  <div class="preferences-body">
    <div
      :key="currentNavItem"
      class="preferences-noir-intro"
    >
      <div class="preferences-noir-eyebrow">
        {{ noirSection.eyebrow }}
      </div>
      <h1>{{ noirSection.headline }}</h1>
      <p>{{ noirSection.lead }}</p>
    </div>
    <slot>
      <component
        v-bind="$attrs"
        :is="componentFromNavItem"
        :preferences="preferences"
      />
    </slot>
    <preferences-help class="help" />
  </div>
</template>

<style lang="scss" scoped>
  .preferences-body {
    position: relative;
    display: flex;
    flex-direction: column;

    .help {
      position: absolute;
      bottom: 0.75rem;
      right: 0.75rem;
    }
  }

  .preferences-noir-intro {
    display: none;
  }
</style>
