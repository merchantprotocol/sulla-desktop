// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { nativeAdditionalIntegrations } from './additional';
import { nativeAiInfrastructureIntegrations } from './ai_infrastructure';
import { nativeAiMlIntegrations } from './ai_ml';
import { nativeAnalyticsIntegrations } from './analytics';
import { nativeAutomationIntegrations } from './automation';
import { nativeSlackIntegration } from './communication';
import { nativeCrmSalesIntegrations } from './crm_sales';
import { nativeCustomerSupportIntegrations } from './customer_support';
import { nativeDatabaseIntegrations } from './database';
import { nativeDesignIntegrations } from './design';
import { nativeGitHubIntegration } from './developer_tools';
import { nativeEcommerceIntegrations } from './ecommerce';
import { nativeFileStorageIntegrations } from './file_storage';
import { nativeFinanceIntegrations } from './finance';
import { nativeHrRecruitingIntegrations } from './hr_recruiting';
import { nativeMarketingIntegrations } from './marketing';
import { nativePaidAdsIntegrations } from './paid_ads';
import { nativeProductivityIntegrations } from './productivity';
import { nativeProjectManagementIntegrations } from './project_management';
import { nativeSecurityIntegrations } from './security';
import { nativeSocialMediaIntegrations } from './social_media';

import type { Integration } from '../types';

type NativeIntegrationSource = readonly [name: string, integrations: Record<string, Integration>];

/** Build once at module startup and fail closed instead of silently overriding a card. */
export function buildNativeIntegrationCatalog(sources: readonly NativeIntegrationSource[]): Record<string, Integration> {
  const catalog: Record<string, Integration> = {};
  const owners = new Map<string, string>();
  for (const [sourceName, integrations] of sources) {
    for (const [id, integration] of Object.entries(integrations)) {
      const previous = owners.get(id);
      if (previous) throw new Error(`Duplicate native integration id "${ id }" in ${ previous } and ${ sourceName }`);
      if (integration.id !== id) throw new Error(`Native integration key "${ id }" does not match definition id "${ integration.id }"`);
      owners.set(id, sourceName);
      catalog[id] = integration;
    }
  }
  return catalog;
}

export const nativeIntegrations = buildNativeIntegrationCatalog([
  ['communication', nativeSlackIntegration],
  ['developer_tools', nativeGitHubIntegration],
  ['ai_infrastructure', nativeAiInfrastructureIntegrations],
  ['productivity', nativeProductivityIntegrations],
  ['project_management', nativeProjectManagementIntegrations],
  ['crm_sales', nativeCrmSalesIntegrations],
  ['customer_support', nativeCustomerSupportIntegrations],
  ['marketing', nativeMarketingIntegrations],
  ['finance', nativeFinanceIntegrations],
  ['file_storage', nativeFileStorageIntegrations],
  ['social_media', nativeSocialMediaIntegrations],
  ['ecommerce', nativeEcommerceIntegrations],
  ['hr_recruiting', nativeHrRecruitingIntegrations],
  ['analytics', nativeAnalyticsIntegrations],
  ['automation', nativeAutomationIntegrations],
  ['design', nativeDesignIntegrations],
  ['ai_ml', nativeAiMlIntegrations],
  ['database', nativeDatabaseIntegrations],
  ['paid_ads', nativePaidAdsIntegrations],
  ['security', nativeSecurityIntegrations],
  ['additional', nativeAdditionalIntegrations],
]);
