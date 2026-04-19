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
import { nativeMarketingIntegrations } from './marketing';
import { nativeProductivityIntegrations } from './productivity';
import { nativeProjectManagementIntegrations } from './project_management';
import { nativeFinanceIntegrations } from './finance';
import { nativeFileStorageIntegrations } from './file_storage';
import { nativeSecurityIntegrations } from './security';
import { nativeSocialMediaIntegrations } from './social_media';
import { nativeEcommerceIntegrations } from './ecommerce';
import { nativeHrRecruitingIntegrations } from './hr_recruiting';
import { nativePaidAdsIntegrations } from './paid_ads';

import type { Integration } from '../types';

export const nativeIntegrations: Record<string, Integration> = {
  ...nativeSlackIntegration,
  ...nativeGitHubIntegration,
  ...nativeAiInfrastructureIntegrations,
  ...nativeProductivityIntegrations,
  ...nativeProjectManagementIntegrations,
  ...nativeCrmSalesIntegrations,
  ...nativeCustomerSupportIntegrations,
  ...nativeMarketingIntegrations,
  ...nativeFinanceIntegrations,
  ...nativeFileStorageIntegrations,
  ...nativeSocialMediaIntegrations,
  ...nativeEcommerceIntegrations,
  ...nativeHrRecruitingIntegrations,
  ...nativeAnalyticsIntegrations,
  ...nativeAutomationIntegrations,
  ...nativeDesignIntegrations,
  ...nativeAiMlIntegrations,
  ...nativeDatabaseIntegrations,
  ...nativePaidAdsIntegrations,
  ...nativeSecurityIntegrations,
};
