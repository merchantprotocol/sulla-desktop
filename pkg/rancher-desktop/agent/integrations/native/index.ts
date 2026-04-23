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
