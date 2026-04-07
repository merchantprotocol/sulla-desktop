export type AppCategory = 'productivity' | 'communication' | 'browsers' | 'media' | 'system' | 'third-party';

export interface AppEntry {
  bundleId:       string;
  name:           string;
  description:    string;
  category:       AppCategory;
  defaultEnabled: boolean;
}

export const APP_CATEGORIES: { id: AppCategory; label: string }[] = [
  { id: 'productivity',  label: 'Productivity' },
  { id: 'communication', label: 'Communication' },
  { id: 'browsers',      label: 'Browsers' },
  { id: 'media',         label: 'Media' },
  { id: 'system',        label: 'System' },
  { id: 'third-party',   label: 'Third Party' },
];

export const APP_REGISTRY: AppEntry[] = [
  // ── Productivity ──
  {
    bundleId:       'com.apple.iCal',
    name:           'Calendar',
    description:    'Create events, check your schedule, manage invitations and RSVPs',
    category:       'productivity',
    defaultEnabled: false,
  },
  {
    bundleId:       'com.apple.reminders',
    name:           'Reminders',
    description:    'Create and complete reminders, manage lists and due dates',
    category:       'productivity',
    defaultEnabled: false,
  },
  {
    bundleId:       'com.apple.Notes',
    name:           'Notes',
    description:    'Read, create, and edit notes across all your folders',
    category:       'productivity',
    defaultEnabled: false,
  },
  {
    bundleId:       'com.apple.AddressBook',
    name:           'Contacts',
    description:    'Look up contact details, create and update contact records',
    category:       'productivity',
    defaultEnabled: false,
  },

  // ── Communication ──
  {
    bundleId:       'com.apple.mail',
    name:           'Mail',
    description:    'Read, compose, and send emails, manage mailboxes and rules',
    category:       'communication',
    defaultEnabled: false,
  },
  {
    bundleId:       'com.apple.MobileSMS',
    name:           'Messages',
    description:    'Send and read iMessages and SMS',
    category:       'communication',
    defaultEnabled: false,
  },
  {
    bundleId:       'com.apple.FaceTime',
    name:           'FaceTime',
    description:    'Initiate audio and video calls',
    category:       'communication',
    defaultEnabled: false,
  },

  // ── Browsers ──
  {
    bundleId:       'com.apple.Safari',
    name:           'Safari',
    description:    'Open URLs, read page content, manage tabs and bookmarks',
    category:       'browsers',
    defaultEnabled: false,
  },
  {
    bundleId:       'com.google.Chrome',
    name:           'Google Chrome',
    description:    'Open URLs, manage tabs, read page content',
    category:       'browsers',
    defaultEnabled: false,
  },
  {
    bundleId:       'company.thebrowser.Browser',
    name:           'Arc',
    description:    'Open URLs, manage tabs and spaces',
    category:       'browsers',
    defaultEnabled: false,
  },

  // ── Media ──
  {
    bundleId:       'com.apple.Music',
    name:           'Music',
    description:    'Play, pause, skip, queue songs, search your library',
    category:       'media',
    defaultEnabled: false,
  },
  {
    bundleId:       'com.apple.Photos',
    name:           'Photos',
    description:    'Browse, search, and export photos',
    category:       'media',
    defaultEnabled: false,
  },
  {
    bundleId:       'com.apple.QuickTimePlayerX',
    name:           'QuickTime Player',
    description:    'Open and control media playback',
    category:       'media',
    defaultEnabled: false,
  },

  // ── System ──
  {
    bundleId:       'com.apple.finder',
    name:           'Finder',
    description:    'Manage files, open folders, move and organize documents',
    category:       'system',
    defaultEnabled: false,
  },
  {
    bundleId:       'com.apple.systemevents',
    name:           'System Events',
    description:    'Control system-level automation: keystrokes, UI elements, processes',
    category:       'system',
    defaultEnabled: false,
  },
  {
    bundleId:       'com.apple.Terminal',
    name:           'Terminal',
    description:    'Run shell commands and scripts',
    category:       'system',
    defaultEnabled: false,
  },
  {
    bundleId:       'com.apple.systempreferences',
    name:           'System Settings',
    description:    'Toggle Wi-Fi, Dark Mode, Do Not Disturb, and other system preferences',
    category:       'system',
    defaultEnabled: false,
  },

  // ── Third Party ──
  {
    bundleId:       'com.spotify.client',
    name:           'Spotify',
    description:    'Playback control, queue songs, search your library',
    category:       'third-party',
    defaultEnabled: false,
  },
  {
    bundleId:       'com.tinyspeck.slackmacgap',
    name:           'Slack',
    description:    'Send messages, set status, manage channels',
    category:       'third-party',
    defaultEnabled: false,
  },
  {
    bundleId:       'com.culturedcode.ThingsMac',
    name:           'Things',
    description:    'Create and manage tasks and projects',
    category:       'third-party',
    defaultEnabled: false,
  },
  {
    bundleId:       'com.omnigroup.OmniFocus4',
    name:           'OmniFocus',
    description:    'Create tasks, manage projects and perspectives',
    category:       'third-party',
    defaultEnabled: false,
  },
  {
    bundleId:       'com.flexibits.fantastical2.mac',
    name:           'Fantastical',
    description:    'Create events and reminders with natural language',
    category:       'third-party',
    defaultEnabled: false,
  },
  {
    bundleId:       'net.shinyfrog.bear',
    name:           'Bear',
    description:    'Create and search notes with tags and markdown',
    category:       'third-party',
    defaultEnabled: false,
  },
  {
    bundleId:       'com.googlecode.iterm2',
    name:           'iTerm2',
    description:    'Run shell commands in iTerm sessions',
    category:       'third-party',
    defaultEnabled: false,
  },
];
