<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<!--
  Sulla Desktop · https://sulladesktop.com
  Portions Copyright SUSE LLC and the Rancher Desktop contributors, licensed under
  the Apache License 2.0 (LICENSES/Apache-2.0.txt).
  Modifications Copyright (c) 2025-2026 Merchant Protocol LLC, licensed under the
  GPL-2.0-or-later (LICENSE).
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script lang="ts">
import { defineComponent } from 'vue';
import { mapGetters } from 'vuex';

import BackendProgress from '@pkg/components/BackendProgress.vue';
import StatusBarItem, { StatusBarItemData } from '@pkg/components/StatusBarItem.vue';

interface BarItem {
  name:       string,
  component?: string,
  icon:       string,
  data?:      StatusBarItemData,
}

export default defineComponent({
  name:       'status-bar',
  components: { BackendProgress, StatusBarItem },
  computed:   {
    ...mapGetters('preferences', ['getPreferences']),
    containerEngine(): string {
      return this.getPreferences.containerEngine.name;
    },
    items(): BarItem[] {
      return [
        {
          name: 'version', component: 'Version', icon: 'icon icon-rancher-desktop',
        }, {
          name: 'network', component: 'NetworkStatus', icon: 'icon icon-globe',
        }, {
          name: 'containerEngine',
          icon: 'icon icon-init_container',
          data: {
            label: {
              bar:     'product.containerEngine.abbreviation',
              tooltip: 'product.containerEngine.fullName',
            },
            value: this.containerEngine,
          },
        },
      ];
    },
  },
});
</script>

<template>
  <footer>
    <div class="left-column">
      <status-bar-item
        v-for="item in items"
        :key="item.name"
        :ref="item.name"
        :sub-component="item.component"
        :data="item.data"
        :icon="item.icon"
        class="status-bar-item"
      />
    </div>
    <div class="right-column">
      <BackendProgress class="progress" />
    </div>
  </footer>
</template>

<style scoped lang="scss">
footer {
  align-items: center;
  display: flex;
  flex-direction: row;
  padding: 5px 10px;
  background-color: var(--footer-bg);
  font-size: var(--fs-body-sm);

  .left-column {
    display: flex;
    white-space: nowrap;
  }

  .right-column {
    display: flex;
    justify-content: flex-end;
    flex: 1;
  }

  .status-bar-item {
    padding-right: 18px;
    text-overflow: ellipsis;
    overflow: hidden;
  }
}
</style>
