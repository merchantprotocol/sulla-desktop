<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!--
  Sulla Desktop · https://sulladesktop.com
  Portions Copyright SUSE LLC and the Rancher Desktop contributors, licensed under
  the Apache License 2.0 (LICENSES/Apache-2.0.txt).
  Modifications Copyright (c) 2025-2026 Merchant Protocol LLC, licensed under the
  GPL-2.0-or-later (LICENSE).
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script>
import RdCheckbox from '@pkg/components/form/RdCheckbox.vue';

export default {
  components: { RdCheckbox },
  props:      {
    // misc
    telemetry: {
      type:    Boolean,
      default: false,
    },
    isTelemetryLocked: {
      type:    Boolean,
      default: false,
    },
  },
  methods: {
    toggleTelemetry(value) {
      this.$emit('updateTelemetry', value);
    },
  },
};
</script>

<template>
  <div class="system-preferences">
    <div class="checkbox">
      <rd-checkbox
        :value="telemetry"
        :is-locked="isTelemetryLocked"
        label="Allow collection of anonymous statistics to help us improve Sulla Desktop"
        @update:value="toggleTelemetry"
      />
      <p class="fineprint">
        Send anonymized usage info, error reports, etc. to help improve Sulla Desktop. Your data will not be shared with anyone else, and no information about what specific resources or endpoints you are deploying is included.
      </p>
    </div>
  </div>
</template>

<style scoped>
p.fineprint {
  font-size: small;
  margin-top: 2px;
  color: var(--input-label);
}
</style>
