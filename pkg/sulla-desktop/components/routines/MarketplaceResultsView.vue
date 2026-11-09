<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template><div /></template>
<script setup lang="ts">
import type { MarketplaceFacet, MarketplaceSearchState } from '@pkg/composables/MarketplaceSearchService';
import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';

defineProps<{
  rows: MarketplaceBrowseRow[];
  facets: MarketplaceFacet[];
  state: MarketplaceSearchState;
  loading: boolean;
  installState?: (row: MarketplaceBrowseRow) => string;
  installingId: string | null;
}>();
defineEmits<{
  'update:state': [state: MarketplaceSearchState];
  'open-detail': [row: MarketplaceBrowseRow];
  install: [row: MarketplaceBrowseRow];
  close: [];
}>();
</script>
