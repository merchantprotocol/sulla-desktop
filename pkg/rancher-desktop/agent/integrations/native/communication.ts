import type { Integration } from '../types';

export const nativeSlackIntegration: Record<string, Integration> = {
  slack: {
    id: 'slack',
    sort: 1,
    paid: false,
    beta: false,
    comingSoon:false,
    name: 'Slack',
    description: 'Team collaboration platform that brings all your communication together. Enable SULLA to send notifications, share updates, and interact with team members through channels and direct messages.',
    category: 'Communication',
    icon: 'slack.svg',
    connected: false,
    version: '1.0.0',
    lastUpdated: '2026-02-06 21:00:00',
    developer: 'Jonathon Byrdziak & Alan Carvalho',
    formGuide: 'Follow the installation guide below to create and configure your Slack app.',
    installationGuide: {
      title: 'Slack Bot Setup Guide',
      description: 'Create a custom Slack app for your personal workspace (5-7 minutes)',
      steps: [
        {
          title: 'Create Slack App',
          content: `1. Go to https://api.slack.com/apps
2. Click "Create New App" → "From scratch"
3. Name your app and select your workspace
4. Click "Create App"`
        },
        {
          title: 'Enable Socket Mode',
          content: `1. In the left menu, go to "Socket Mode"
2. Toggle "Enable Socket Mode" to ON
3. Click "Generate" to create a new App-Level Token
4. No special scopes needed for this token
5. Copy the generated token (starts with xapp-)
6. Save this token as your "Scopes Token" in Sulla`
        },
        {
          title: 'Configure Bot Permissions',
          content: `1. In the left menu, go to "OAuth & Permissions"
2. Scroll to "Bot Token Scopes"
3. Click "Add an OAuth Scope" and add:
   • chat:write
   • files:write
   • channels:read
   • groups:read
   • im:read
   • mpim:read
   • users:read
   • users:read.email
4. Click "Save Changes"`
        },
        {
          title: 'Install App to Workspace',
          content: `1. Scroll to top of "OAuth & Permissions" page
2. Click "Install to Workspace" (or "Reinstall" if updating)
3. Review permissions and click "Allow"
4. Copy the "Bot User OAuth Token" (starts with xoxb-)
5. Save this token as your "Bot Token" in Sulla`
        },
        {
          title: 'Invite Bot to Channel',
          content: `1. Go to any Slack channel where you want the bot to work
2. Type: /invite @YourBotName
3. Or click the channel name → "Integrations" → "Add apps"
4. Find and add your bot to the channel`
        }
      ],
      importantNotes: [
        'Keep both tokens secure - they provide full access to your workspace',
        'The bot can only see messages in channels where it\'s been invited',
        'Socket Mode is required for local development without public webhooks',
        'You must be a workspace admin to create custom apps'
      ]
    },
    guideLinks: [
      {
        title: 'Slack App Dashboard',
        description: 'Manage your Slack apps and configurations',
        url: 'https://api.slack.com/apps'
      },
      {
        title: 'Bot Token Documentation',
        description: 'Learn about Slack bot tokens and permissions',
        url: 'https://api.slack.com/authentication/basics'
      },
      {
        title: 'Socket Mode Guide',
        description: 'Understanding Socket Mode for local development',
        url: 'https://api.slack.com/apis/connections/socket'
      }
    ],
    media: [
      {
        type: 'youtube',
        url: 'EDATYbzYGiE',
        alt: 'Slack Platform Overview',
        caption: 'Watch how Slack transforms team communication and collaboration'
      },
      {
        type: 'image',
        url: 'slack-media-1.jpeg',
        alt: 'Slack Desktop Client',
        caption: 'Native Slack desktop application'
      },
      {
        type: 'image',
        url: 'slack-media-2.png',
        alt: 'Slack Integrations',
        caption: 'Slack integrations marketplace'
      }
    ],
    features: [
      {
        title: 'Channel Organization',
        description: 'Organize conversations by topic, project, or team with unlimited channels'
      },
      {
        title: 'Direct Messaging',
        description: 'One-on-one and group conversations with team members'
      },
      {
        title: 'File Sharing',
        description: 'Share documents, images, and integrate with cloud storage services'
      },
      {
        title: 'App Integrations',
        description: 'Connect thousands of apps for automated workflows and notifications'
      }
    ],
    properties: [
      {
        key: 'bot_token',
        title: 'Bot User OAuth Token',
        hint: '',
        type: 'password',
        required: true,
        placeholder: ''
      },
      {
        key: 'scopes_token',
        title: 'Scopes Token',
        hint: '',
        type: 'password',
        required: true,
        placeholder: ''
      }
    ],
  },
  gmail: {
    id: 'gmail', sort: 2, paid: false, beta: false, comingSoon: false, connected: false,
    name: 'Gmail', description: 'Send, receive, and manage emails. Automate email workflows, parse incoming messages, and create drafts.',
    category: 'Communication', icon: 'gmail.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Google',
    authType: 'oauth',
    oauthProviderId: 'google',
    formGuide: 'Create OAuth credentials in Google Cloud Console, then click "Connect with Google" below.',
    properties: [
      {
        key: 'client_id',
        title: 'OAuth Client ID',
        hint: 'From Google Cloud Console → Credentials',
        type: 'text',
        required: true,
        placeholder: 'xxxx.apps.googleusercontent.com'
      },
      {
        key: 'client_secret',
        title: 'OAuth Client Secret',
        hint: 'From Google Cloud Console → Credentials',
        type: 'password',
        required: true,
        placeholder: ''
      }
    ],
  },
  discord: {
    id: 'discord', sort: 3, paid: false, beta: false, comingSoon: false, connected: false,
    name: 'Discord', description: 'Send messages, manage channels, and interact with community members on Discord servers.',
    category: 'Communication', icon: 'discord.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Discord',
  },
  telegram: {
    id: 'telegram', sort: 4, paid: false, beta: false, comingSoon: false, connected: false,
    name: 'Telegram', description: 'Send messages, manage bots, and automate Telegram channel and group interactions.',
    category: 'Communication', icon: 'telegram.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Telegram',
  },
  zoom: {
    id: 'zoom', sort: 5, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Zoom', description: 'Schedule and manage meetings, retrieve recordings, and automate video conferencing workflows.',
    category: 'Communication', icon: 'zoom.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Zoom',
  },
  microsoft_teams: {
    id: 'microsoft_teams', sort: 6, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Microsoft Teams', description: 'Send messages, manage channels, and automate team collaboration in Microsoft Teams.',
    category: 'Communication', icon: 'microsoft_teams.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Microsoft',
  },
  twilio: {
    id: 'twilio', sort: 7, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Twilio', description: 'Send SMS, make voice calls, and manage communication workflows via the Twilio API.',
    category: 'Communication', icon: 'twilio.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Twilio',
  },
  whatsapp: {
    id: 'whatsapp', sort: 8, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'WhatsApp Business', description: 'Send and receive WhatsApp messages, manage templates, and automate customer conversations.',
    category: 'Communication', icon: 'whatsapp.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Meta',
  },
  sendgrid_email: {
    id: 'sendgrid_email', sort: 9, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'SendGrid Email', description: 'Send transactional emails, manage contacts, and track delivery and engagement.',
    category: 'Communication', icon: 'sendgrid_email.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Twilio',
  },
  microsoft_outlook: {
    id: 'microsoft_outlook', sort: 10, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Microsoft Outlook', description: 'Send and manage emails, calendar events, and contacts via the Microsoft Graph API.',
    category: 'Communication', icon: 'microsoft_outlook.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Microsoft',
  },
  vonage: {
    id: 'vonage', sort: 11, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Vonage', description: 'Send SMS, voice, and video communications via the Vonage APIs.',
    category: 'Communication', icon: 'vonage.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Vonage',
  },
  signal: {
    id: 'signal', sort: 12, paid: false, beta: false, comingSoon: false, connected: false,
    name: 'Signal', description: 'Send encrypted messages and automate secure messaging workflows.',
    category: 'Communication', icon: 'signal.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Signal Foundation',
  },
  google_meet: {
    id: 'google_meet', sort: 13, paid: false, beta: false, comingSoon: false, connected: false,
    name: 'Google Meet', description: 'Schedule and manage video meetings via the Google Calendar and Meet APIs.',
    category: 'Communication', icon: 'google_meet.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Google',
  },
  webex: {
    id: 'webex', sort: 14, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Webex', description: 'Schedule meetings, send messages, and manage rooms in Cisco Webex.',
    category: 'Communication', icon: 'webex.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Cisco',
  },
  mattermost: {
    id: 'mattermost', sort: 15, paid: false, beta: false, comingSoon: false, connected: false,
    name: 'Mattermost', description: 'Send messages, manage channels, and automate workflows on self-hosted Mattermost.',
    category: 'Communication', icon: 'mattermost.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Mattermost',
  },
  rocket_chat: {
    id: 'rocket_chat', sort: 16, paid: false, beta: false, comingSoon: false, connected: false,
    name: 'Rocket.Chat', description: 'Send messages, manage channels, and integrate bots on Rocket.Chat servers.',
    category: 'Communication', icon: 'rocket_chat.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Rocket.Chat',
  },
  messagebird: {
    id: 'messagebird', sort: 17, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'MessageBird', description: 'Send SMS, WhatsApp, and voice messages via the MessageBird omnichannel API.',
    category: 'Communication', icon: 'messagebird.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'MessageBird',
  },
  pushover: {
    id: 'pushover', sort: 18, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Pushover', description: 'Send real-time push notifications to mobile and desktop devices.',
    category: 'Communication', icon: 'pushover.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Pushover',
  },
};
