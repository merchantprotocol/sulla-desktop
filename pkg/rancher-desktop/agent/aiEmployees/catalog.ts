import type { AiEmployee } from './types';

/**
 * The initial roster of hireable AI employees.
 *
 * Keyed by employee id (mirrors the native integration catalog shape). Kept as
 * plain data so it can be served over IPC, filtered, and rendered without any
 * runtime dependencies. Tiers reference cloud/overview.md: free (Desktop),
 * premium_support ($19/mo), enterprise_gateway ($99/mo).
 */
export const aiEmployeeCatalog: Record<string, AiEmployee> = {
  'executive-assistant': {
    id:           'executive-assistant',
    name:         'Executive Assistant',
    role:         'Manages your inbox, calendar, and daily coordination.',
    description:  'Triages email, schedules meetings, and drafts replies so your day runs itself.',
    longDescription:
      'The Executive Assistant keeps your inbox and calendar under control. It triages incoming '
      + 'mail, proposes and books meetings around your existing commitments, drafts routine replies '
      + 'for your approval, and gives you a daily briefing of what needs attention first.',
    category:     'Productivity',
    icon:         'ai-employee-assistant.svg',
    requiredTier: 'free',
    capabilities: [
      'Inbox triage and prioritization',
      'Calendar scheduling and conflict resolution',
      'Drafting replies and follow-ups',
      'Daily briefing of what needs attention',
    ],
    exampleTasks: [
      'Find a 30-minute slot with the design team this week and send invites.',
      'Summarize everything in my inbox since yesterday and flag anything urgent.',
    ],
    integrationsUsed: ['gmail', 'google-calendar', 'slack'],
    sort:         1,
    version:      '1.0.0',
    lastUpdated:  '2026-08-24',
    developer:    'Sulla',
  },
  'customer-support-agent': {
    id:           'customer-support-agent',
    name:         'Customer Support Agent',
    role:         'Answers customer questions and triages support tickets.',
    description:  'Drafts helpful, on-brand replies and routes tickets to the right place.',
    longDescription:
      'The Customer Support Agent watches your support inbox and help desk, drafts accurate replies '
      + 'grounded in your knowledge base, tags and prioritizes tickets, and escalates anything it is '
      + 'not confident about to a human.',
    category:     'Customer Support',
    icon:         'ai-employee-support.svg',
    requiredTier: 'free',
    capabilities: [
      'Draft grounded replies from your knowledge base',
      'Tag, prioritize, and route tickets',
      'Escalate low-confidence cases to a human',
      'Summarize recurring issues',
    ],
    exampleTasks: [
      'Draft a reply to the top 10 unanswered tickets and flag anything needing a refund.',
      'Summarize the most common complaints from this week.',
    ],
    integrationsUsed: ['zendesk', 'slack', 'gmail'],
    sort:         2,
    version:      '1.0.0',
    lastUpdated:  '2026-08-24',
    developer:    'Sulla',
  },
  'bookkeeper': {
    id:           'bookkeeper',
    name:         'Bookkeeper',
    role:         'Keeps the books tidy and reconciles transactions.',
    description:  'Categorizes expenses, reconciles accounts, and flags anomalies.',
    longDescription:
      'The Bookkeeper reconciles transactions against your accounting system, categorizes expenses, '
      + 'chases missing receipts, and flags anomalies or duplicate charges before they become a mess '
      + 'at month end.',
    category:     'Finance',
    icon:         'ai-employee-bookkeeper.svg',
    requiredTier: 'premium_support',
    capabilities: [
      'Transaction categorization',
      'Account reconciliation',
      'Anomaly and duplicate-charge detection',
      'Month-end close checklist',
    ],
    exampleTasks: [
      'Reconcile last month against the bank feed and list anything unmatched.',
      'Flag any expense over $500 without a receipt.',
    ],
    integrationsUsed: ['quickbooks', 'stripe'],
    sort:         1,
    version:      '1.0.0',
    lastUpdated:  '2026-08-24',
    developer:    'Sulla',
  },
  'data-analyst': {
    id:           'data-analyst',
    name:         'Data Analyst',
    role:         'Turns your data into answers and dashboards.',
    description:  'Runs queries, builds charts, and explains what the numbers mean.',
    longDescription:
      'The Data Analyst connects to your databases and analytics tools, answers ad-hoc questions in '
      + 'plain language, builds recurring dashboards, and proactively surfaces trends and outliers.',
    category:     'Analytics',
    icon:         'ai-employee-analyst.svg',
    requiredTier: 'premium_support',
    capabilities: [
      'Natural-language querying',
      'Chart and dashboard generation',
      'Trend and outlier detection',
      'Scheduled reporting',
    ],
    exampleTasks: [
      'What were our top 5 revenue sources last quarter, with a chart?',
      'Build a weekly dashboard of signups vs. churn.',
    ],
    integrationsUsed: ['postgres', 'google-analytics'],
    sort:         1,
    version:      '1.0.0',
    lastUpdated:  '2026-08-24',
    developer:    'Sulla',
  },
  'sales-development-rep': {
    id:           'sales-development-rep',
    name:         'Sales Development Rep',
    role:         'Finds leads, researches accounts, and drafts outreach.',
    description:  'Builds targeted prospect lists and personalized first-touch emails.',
    longDescription:
      'The Sales Development Rep researches target accounts, enriches and qualifies leads, drafts '
      + 'personalized outreach sequences, and keeps your CRM up to date so your pipeline never goes '
      + 'stale.',
    category:     'Sales',
    icon:         'ai-employee-sdr.svg',
    requiredTier: 'enterprise_gateway',
    capabilities: [
      'Account research and lead enrichment',
      'Personalized outreach drafting',
      'CRM hygiene and updates',
      'Follow-up sequencing',
    ],
    exampleTasks: [
      'Build a list of 25 SaaS companies in Idaho and draft a first-touch email for each.',
      'Update the CRM with notes from this weeks replies.',
    ],
    integrationsUsed: ['hubspot', 'linkedin', 'gmail'],
    sort:         1,
    version:      '1.0.0',
    lastUpdated:  '2026-08-24',
    developer:    'Sulla',
  },
  'marketing-manager': {
    id:           'marketing-manager',
    name:         'Marketing Manager',
    role:         'Plans campaigns and drafts content across channels.',
    description:  'Drafts posts, schedules content, and reports on what is working.',
    longDescription:
      'The Marketing Manager plans content calendars, drafts on-brand posts and newsletters, '
      + 'schedules them across channels, and reports on engagement so you can double down on what '
      + 'works.',
    category:     'Marketing',
    icon:         'ai-employee-marketing.svg',
    requiredTier: 'enterprise_gateway',
    capabilities: [
      'Content calendar planning',
      'On-brand copy drafting',
      'Cross-channel scheduling',
      'Engagement reporting',
    ],
    exampleTasks: [
      'Draft a week of LinkedIn posts announcing our new feature.',
      'Report on which posts drove the most signups last month.',
    ],
    integrationsUsed: ['linkedin', 'mailchimp', 'google-analytics'],
    sort:         2,
    version:      '1.0.0',
    lastUpdated:  '2026-08-24',
    developer:    'Sulla',
  },
  'recruiter': {
    id:           'recruiter',
    name:         'Recruiter',
    role:         'Sources candidates and manages your hiring pipeline.',
    description:  'Screens applicants, schedules interviews, and keeps candidates warm.',
    longDescription:
      'The Recruiter drafts job posts, screens inbound applicants against your criteria, schedules '
      + 'interviews, and sends timely, personable follow-ups so no candidate falls through the '
      + 'cracks.',
    category:     'HR & Recruiting',
    icon:         'ai-employee-recruiter.svg',
    requiredTier: 'enterprise_gateway',
    capabilities: [
      'Job-post drafting',
      'Applicant screening against criteria',
      'Interview scheduling',
      'Candidate follow-up',
    ],
    exampleTasks: [
      'Screen this weeks applicants for the backend role and shortlist the top 5.',
      'Schedule interviews with the shortlist next week.',
    ],
    integrationsUsed: ['greenhouse', 'gmail', 'google-calendar'],
    sort:         1,
    version:      '1.0.0',
    lastUpdated:  '2026-08-24',
    developer:    'Sulla',
  },
  'it-helpdesk': {
    id:           'it-helpdesk',
    name:         'IT Helpdesk',
    role:         'Handles internal IT requests and access provisioning.',
    description:  'Resets access, answers how-to questions, and tracks assets.',
    longDescription:
      'The IT Helpdesk answers common internal IT questions, guides employees through fixes, and '
      + 'drafts access-provisioning requests for approval. Deeper automation (SSO, MDM) is on the '
      + 'roadmap.',
    category:     'IT',
    icon:         'ai-employee-it.svg',
    requiredTier: 'enterprise_gateway',
    capabilities: [
      'Answer common IT how-to questions',
      'Guide employees through fixes',
      'Draft access-provisioning requests',
      'Track asset assignments',
    ],
    exampleTasks: [
      'Draft an onboarding checklist for a new hire including accounts to create.',
    ],
    integrationsUsed: ['slack', 'okta'],
    sort:         2,
    beta:         true,
    comingSoon:   true,
    version:      '0.1.0',
    lastUpdated:  '2026-08-24',
    developer:    'Sulla',
  },
};
