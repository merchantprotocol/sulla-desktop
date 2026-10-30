// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Lightweight update check: reads the update feed (latest-mac.yml) directly,
 * without going through electron-updater. Works in both development (unpacked)
 * and production (packaged) builds.
 *
 * It reads the same feed electron-updater uses (the generic provider URL from
 * app-update.yml, or dev-app-update.yml when running from source), so the two
 * stages of UpdateManager.checkForUpdates() can never disagree about the
 * latest version. Production builds use this to display what's available, then
 * hand off to electron-updater for the actual download/install. Development
 * builds only get the "available" info — they can't actually install.
 */

import fs from 'fs';
import path from 'path';

import { app, net } from 'electron';
import { ElectronAppAdapter } from 'electron-updater/out/ElectronAppAdapter';
import semver from 'semver';
import yaml from 'yaml';

import Logging from '@pkg/utils/logging';

const console = Logging.update;

export interface LightweightCheckResult {
  /** Whether a newer version is available. */
  updateAvailable: boolean;
  /** The current running version. */
  currentVersion:  string;
  /** The latest version in the feed. */
  latestVersion?:  string;
  /** ISO date string for when the latest version was released. */
  releaseDate?:    string;
  /** Markdown release notes, if the feed carries them. */
  releaseNotes?:   string;
  /** The feed file that was read (for debugging). */
  feedUrl:         string;
  /** Whether the feed has not been published yet. */
  feedMissing?:    boolean;
}

interface UpdateYaml {
  provider?: string;
  url?:      string;
}

interface FeedYaml {
  version?:      string;
  releaseDate?:  string;
  releaseNotes?: unknown;
}

/** The feed file electron-updater's generic provider reads on macOS. */
const FEED_FILE = 'latest-mac.yml';

async function readYaml<T>(file: string): Promise<T | undefined> {
  try {
    return (yaml.parse(await fs.promises.readFile(file, 'utf8')) ?? undefined) as T | undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[lightweightCheck] failed to read ${ file }:`, err);
    }

    return undefined;
  }
}

/**
 * Resolve the feed base URL from `app-update.yml` in packaged resources
 * (written by electron-builder from packaging/electron-builder.yml), falling
 * back to `dev-app-update.yml` when running from source.
 */
async function resolveFeedBaseUrl(): Promise<string> {
  const candidates = [
    new ElectronAppAdapter().appUpdateConfigPath,
    path.join(app.getAppPath(), 'dev-app-update.yml'),
    path.join(process.cwd(), 'dev-app-update.yml'),
  ];

  for (const candidate of candidates) {
    const config = await readYaml<UpdateYaml>(candidate);

    if (config?.provider === 'generic' && config.url) {
      return config.url;
    }
  }
  throw new Error('No update feed configured (expected a generic provider url in app-update.yml or dev-app-update.yml).');
}

/**
 * Perform a lightweight update check. Always works, regardless of whether the
 * app is packaged or not.
 */
export async function performLightweightCheck(): Promise<LightweightCheckResult> {
  const currentVersion = app.getVersion();
  const base = await resolveFeedBaseUrl();
  const feedUrl = new URL(FEED_FILE, base.endsWith('/') ? base : `${ base }/`).toString();
  const response = await net.fetch(feedUrl, { cache: 'no-store' });

  // A missing feed is expected before the first release is published. Treat
  // it as an empty release channel rather than surfacing a noisy 404 error.
  if (response.status === 404) {
    return {
      updateAvailable: false,
      currentVersion,
      feedUrl,
      feedMissing: true,
    };
  }

  if (!response.ok) {
    throw new Error(`Update feed ${ feedUrl } returned HTTP ${ response.status }`);
  }
  const feed: FeedYaml = yaml.parse(await response.text()) ?? {};
  const latest = semver.parse(String(feed.version ?? ''), { loose: true });

  if (!latest) {
    throw new Error(`Update feed ${ feedUrl } has no valid version`);
  }
  const current = semver.parse(currentVersion, { loose: true });
  const updateAvailable = current ? semver.gt(latest, current) : false;

  return {
    updateAvailable,
    currentVersion,
    latestVersion: latest.version,
    releaseDate:   feed.releaseDate ? String(feed.releaseDate) : undefined,
    releaseNotes:  typeof feed.releaseNotes === 'string' ? feed.releaseNotes : undefined,
    feedUrl,
  };
}
