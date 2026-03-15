<script lang="ts">

import { defineComponent } from 'vue';

import DiagnosticsBody from '@pkg/components/DiagnosticsBody.vue';
import { mapTypedState } from '@pkg/entry/store';
import PostHogTracker from '@pkg/components/PostHogTracker.vue';

export default defineComponent({
  name:       'diagnostics',
  components: { DiagnosticsBody, PostHogTracker },

  computed: mapTypedState('diagnostics', ['diagnostics', 'timeLastRun']),
  async beforeMount() {
    await this.$store.dispatch('credentials/fetchCredentials');
    await this.$store.dispatch('preferences/fetchPreferences');
    await this.$store.dispatch('diagnostics/fetchDiagnostics');
  },
  mounted() {
    this.$store.dispatch(
      'page/setHeader',
      { title: 'Diagnostics' },
    );
  },
});
</script>

<template>
  <div>
    <PostHogTracker page-name="Diagnostics" />
    <diagnostics-body
      :rows="diagnostics"
      :time-last-run="timeLastRun"
    />
  </div>
</template>
