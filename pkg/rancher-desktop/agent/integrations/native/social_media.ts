import type { Integration } from '../types';

export const nativeSocialMediaIntegrations: Record<string, Integration> = {
  twitter: {
    id: 'twitter', sort: 1, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'X (Twitter)', description: 'Post tweets, read timelines, manage followers, and automate social engagement.',
    category: 'Social Media', icon: 'twitter.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'X Corp',
  },
  linkedin: {
    id: 'linkedin', sort: 2, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'LinkedIn', description: 'Post updates, manage company pages, and automate professional networking workflows.',
    category: 'Social Media', icon: 'linkedin.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Microsoft',
  },
  instagram: {
    id: 'instagram', sort: 3, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Instagram', description: 'Manage posts, stories, and comments. Track engagement and automate content publishing.',
    category: 'Social Media', icon: 'instagram.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Meta',
  },
  youtube: {
    id: 'youtube', sort: 4, paid: false, beta: false, comingSoon: false, connected: false,
    name: 'YouTube', description: 'Search videos, manage playlists, retrieve channel info, and automate content workflows via the YouTube Data API v3.',
    category: 'Social Media', icon: 'youtube.svg', version: '1.0.0', lastUpdated: '2026-03-06', developer: 'Google',
    formGuide: 'Go to console.cloud.google.com → APIs & Services → Credentials → Create an API key. Then enable the "YouTube Data API v3" under APIs & Services → Library.',
    properties: [
      {
        key: 'api_key',
        title: 'YouTube Data API Key',
        hint: 'From Google Cloud Console → Credentials. Enable "YouTube Data API v3" in the API Library.',
        type: 'password',
        required: true,
        placeholder: 'AIzaSy...',
      },
    ],
  },
  tiktok: {
    id: 'tiktok', sort: 5, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'TikTok', description: 'Manage video content, track analytics, and automate TikTok marketing workflows.',
    category: 'Social Media', icon: 'tiktok.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'ByteDance',
  },
  buffer: {
    id: 'buffer', sort: 6, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Buffer', description: 'Schedule posts, manage publishing queues, and track social media performance across platforms.',
    category: 'Social Media', icon: 'buffer.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Buffer',
  },
  hootsuite: {
    id: 'hootsuite', sort: 7, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Hootsuite', description: 'Schedule posts, monitor mentions, and manage social accounts across networks.',
    category: 'Social Media', icon: 'hootsuite.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Hootsuite',
  },
  pinterest: {
    id: 'pinterest', sort: 8, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Pinterest', description: 'Create pins, manage boards, and track engagement on Pinterest.',
    category: 'Social Media', icon: 'pinterest.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Pinterest',
  },
  reddit: {
    id: 'reddit', sort: 9, paid: false, beta: false, comingSoon: false, connected: false,
    name: 'Reddit', description: 'Post, comment, monitor subreddits, and automate Reddit engagement.',
    category: 'Social Media', icon: 'reddit.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Reddit',
  },
  facebook_pages: {
    id: 'facebook_pages', sort: 10, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Facebook Pages', description: 'Manage page posts, comments, messages, and insights.',
    category: 'Social Media', icon: 'facebook_pages.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Meta',
  },
  bluesky: {
    id: 'bluesky', sort: 11, paid: false, beta: false, comingSoon: false, connected: false,
    name: 'Bluesky', description: 'Post, follow, and manage feeds on the Bluesky AT Protocol network.',
    category: 'Social Media', icon: 'bluesky.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Bluesky',
  },
  mastodon: {
    id: 'mastodon', sort: 12, paid: false, beta: false, comingSoon: false, connected: false,
    name: 'Mastodon', description: 'Post toots, manage follows, and interact with the decentralized Fediverse.',
    category: 'Social Media', icon: 'mastodon.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Mastodon',
  },
  threads: {
    id: 'threads', sort: 13, paid: false, beta: false, comingSoon: false, connected: false,
    name: 'Threads', description: 'Post text updates, manage followers, and track engagement on Meta Threads.',
    category: 'Social Media', icon: 'threads.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Meta',
  },
  sprout_social: {
    id: 'sprout_social', sort: 14, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Sprout Social', description: 'Schedule posts, monitor engagement, and analyze social performance.',
    category: 'Social Media', icon: 'sprout_social.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Sprout Social',
  },
  later: {
    id: 'later', sort: 15, paid: true, beta: false, comingSoon: false, connected: false,
    name: 'Later', description: 'Schedule visual content, manage link-in-bio pages, and plan social calendars.',
    category: 'Social Media', icon: 'later.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Later',
  },
  twitch: {
    id: 'twitch', sort: 16, paid: false, beta: false, comingSoon: false, connected: false,
    name: 'Twitch', description: 'Manage streams, chat bots, clips, and channel point rewards.',
    category: 'Social Media', icon: 'twitch.svg', version: '1.0.0', lastUpdated: '2026-02-28', developer: 'Amazon',
  },
};
