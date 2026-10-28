<!--
  Sulla Desktop · https://sulladesktop.com
  Portions Copyright SUSE LLC and the Rancher Desktop contributors, licensed under
  the Apache License 2.0 (LICENSES/Apache-2.0.txt).
  Modifications Copyright (c) 2025-2026 Merchant Protocol LLC, licensed under the
  GPL-2.0-or-later (LICENSE).
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="container">
    <h2>{{ t('unmetPrerequisites.title') }}</h2>
    <p>{{ t('unmetPrerequisites.message') }}</p>
    <ul>
      <li>{{ reason }}</li>
    </ul>
    <p>{{ t('unmetPrerequisites.action') }}</p>
    <div class="button-area">
      <button
        data-test="accept-btn"
        class="role-primary"
        @click="close"
      >
        {{ t('unmetPrerequisites.buttonText') }}
      </button>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { reqMessageId } from '@pkg/window';

function describeReason(reasonId: reqMessageId): string {
  switch (reasonId) {
  case 'macOS-release':
    return 'Requires macOS version 10.15 or newer';
  case 'linux-nested':
    return 'Nested virtualization not enabled on this host';
  }

  return `Reason ${ reasonId } is unknown`;
}

export default defineComponent({
  name:       'unmet-prerequisites-dialog',
  layout:     'dialog',
  components: {},
  data() {
    return {
      reason:   '',
      suppress: false,
    };
  },
  mounted() {
    ipcRenderer.on('dialog/populate', (event, ...args: Parameters<typeof describeReason>) => {
      this.$data.reason = describeReason(...args);
    });
  },
  methods: {
    close() {
      window.close();
    },
  },
});
</script>

<style lang="scss" scoped>
  .container {
    min-width: 30rem;
  }
  .button-area {
    align-self: flex-end;
  }
</style>
