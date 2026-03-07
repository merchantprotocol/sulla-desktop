import type { Integration } from '../types';

export const nativeCrmSalesIntegrations: Record<string, Integration> = {
  hubspot: {
    id: 'hubspot', sort: 1, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'HubSpot', description: 'Manage contacts, deals, and pipelines. Automate CRM workflows and marketing campaigns.',
    category: 'CRM & Sales', icon: 'hubspot.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'HubSpot',
  },
  salesforce: {
    id: 'salesforce', sort: 2, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Salesforce', description: 'Query and manage leads, accounts, opportunities, and custom objects via the Salesforce API.',
    category: 'CRM & Sales', icon: 'salesforce.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Salesforce',
  },
  pipedrive: {
    id: 'pipedrive', sort: 3, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Pipedrive', description: 'Manage deals, contacts, and sales pipelines. Automate sales activity tracking.',
    category: 'CRM & Sales', icon: 'pipedrive.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Pipedrive',
  },
  zoho_crm: {
    id: 'zoho_crm', sort: 4, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Zoho CRM', description: 'Manage leads, contacts, deals, and accounts in Zoho CRM.',
    category: 'CRM & Sales', icon: 'zoho_crm.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Zoho',
  },
  apollo: {
    id: 'apollo', sort: 5, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Apollo.io', description: 'Search contacts, enrich lead data, and manage sales outreach sequences.',
    category: 'CRM & Sales', icon: 'apollo.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Apollo.io',
  },
  close: {
    id: 'close', sort: 6, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Close', description: 'Manage leads, track communications, and automate sales workflows in Close CRM.',
    category: 'CRM & Sales', icon: 'close.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Close',
  },
  freshsales: {
    id: 'freshsales', sort: 7, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Freshsales', description: 'Manage contacts, deals, and accounts with AI-powered lead scoring.',
    category: 'CRM & Sales', icon: 'freshsales.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Freshworks',
  },
  copper: {
    id: 'copper', sort: 8, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Copper', description: 'Manage contacts, leads, and deals in the Google Workspace-native CRM.',
    category: 'CRM & Sales', icon: 'copper.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Copper',
  },
  attio: {
    id: 'attio', sort: 9, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Attio', description: 'Build custom CRM workflows with flexible data models and real-time syncing.',
    category: 'CRM & Sales', icon: 'attio.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Attio',
  },
  outreach: {
    id: 'outreach', sort: 10, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Outreach', description: 'Manage sales sequences, track engagement, and automate outbound prospecting.',
    category: 'CRM & Sales', icon: 'outreach.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Outreach',
  },
  salesloft: {
    id: 'salesloft', sort: 11, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Salesloft', description: 'Manage cadences, track calls and emails, and automate sales engagement.',
    category: 'CRM & Sales', icon: 'salesloft.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Salesloft',
  },
  instantly: {
    id: 'instantly', sort: 12, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Instantly', description: 'Manage cold email campaigns, warm-up accounts, and track outreach deliverability.',
    category: 'CRM & Sales', icon: 'instantly.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Instantly',
  },
  lemlist: {
    id: 'lemlist', sort: 13, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Lemlist', description: 'Build multichannel outreach sequences with email, LinkedIn, and calling.',
    category: 'CRM & Sales', icon: 'lemlist.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Lemlist',
  },
  microsoft_dynamics: {
    id: 'microsoft_dynamics', sort: 14, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Microsoft Dynamics 365', description: 'Manage accounts, contacts, opportunities, and cases in Dynamics CRM.',
    category: 'CRM & Sales', icon: 'microsoft_dynamics.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Microsoft',
  },
  sugarcrm: {
    id: 'sugarcrm', sort: 15, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'SugarCRM', description: 'Manage leads, contacts, accounts, and sales pipeline automation.',
    category: 'CRM & Sales', icon: 'sugarcrm.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'SugarCRM',
  },
  clearbit: {
    id: 'clearbit', sort: 16, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Clearbit', description: 'Enrich contacts and companies with firmographic and technographic data.',
    category: 'CRM & Sales', icon: 'clearbit.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'HubSpot',
  },
  hunter: {
    id: 'hunter', sort: 17, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Hunter.io', description: 'Find and verify professional email addresses for outreach and prospecting.',
    category: 'CRM & Sales', icon: 'hunter.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Hunter',
  },
  smartlead: {
    id: 'smartlead', sort: 18, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Smartlead', description: 'AI-powered cold email outreach. Manage campaigns, leads, mailboxes, and track deliverability.',
    category: 'CRM & Sales', icon: 'smartlead.svg', version: '1.0.0', lastUpdated: '2026-03-07', developer: 'Smartlead',
  },
};
