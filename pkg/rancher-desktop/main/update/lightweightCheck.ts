/**
 * Lightweight update check — queries the upgrade responder directly without
 * going through electron-updater. Works in both development (unpacked) and
 * production (packaged) builds.
 *
 * Production builds use this to display what's available, then hand off to
 * electron-updater for the actual download/install. Development builds only
 * get the "available" info — they can't actually install.
 */

import fs from 'fs';
import path from 'path';

import { app, net } from 'electron';
import { ElectronAppAdapter } from 'electron-updater/out/ElectronAppAdapter';
import semver from 'semver';
import yaml from 'yaml';

import { queryUpgradeResponder } from './LonghornProvider';

import Logging from '@pkg/utils/logging';

const console = Logging.update;

export interface LightweightCheckResult {
  /** Whether a newer version is available. */
  updateAvailable: boolean;
  /** The current running version. */
  currentVersion: string;
  /** The latest version reported by the server, if any. */
  latestVersion?: string;
  /** ISO date string for when the latest version was released. */
  releaseDate?: string;
  /** Markdown release notes from the GitHub release, if available. */
  releaseNotes?: string;
  /** Whether there's an unsupported newer version on this platform. */
  unsupportedUpdateAvailable: boolean;
  /** The responder URL that was queried (for debugging). */
  responderUrl: string;
}

interface UpdateYaml {
  upgradeServer?:    string;
  owner?:            string;
  repo?:             string;
  vPrefixedTagName?: boolean;
}

/**
 * Resolve the update configuration. Tries, in order:
 *   1. `RD_UPGRADE_RESPONDER_URL` env var override (for testing)
 *   2. `app-update.yml` in packaged resources (production)
 *   3. `dev-app-update.yml` at the repo root (development)
 */
async function resolveUpdateConfig(): Promise<UpdateYaml | undefined> {
  let config: UpdateYaml = {};

  // Try the packaged config first.
  try {
    const { appUpdateConfigPath } = new ElectronAppAdapter();
    const contents = await fs.promises.readFile(appUpdateConfigPath, 'utf8');

    config = yaml.parse(contents) ?? {};
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;

    if (code !== 'ENOENT') {
      console.warn('[lightweightCheck] failed to read app-update.yml:', err);
    }
  }

  // Fall back to dev-app-update.yml (cwd when running from source).
  if (!config.upgradeServer) {
    const candidates = [
      path.join(app.getAppPath(), 'dev-app-update.yml'),
      path.join(process.cwd(), 'dev-app-update.yml'),
    ];

    for (const candidatePath of candidates) {
      try {
        const contents = await fs.promises.readFile(candidatePath, 'utf8');

        config = yaml.parse(contents) ?? {};
        console.log(`[lightweightCheck] loaded dev config from ${ candidatePath }`);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;

        if (code !== 'ENOENT') {
          console.warn(`[lightweightCheck] failed to read ${ candidatePath }:`, err);
        }
      }
    }
  }

  // Env var override wins over config file values.
  if (process.env.RD_UPGRADE_RESPONDER_URL) {
    config.upgradeServer = process.env.RD_UPGRADE_RESPONDER_URL;
  }

  if (!config.upgradeServer) {
    return undefined;
  }

  return config;
}

/**
 * Fetch release notes for a given tag from GitHub.
 * Best-effort — returns undefined on any failure.
 */
async function fetchReleaseNotes(owner: string, repo: string, tag: string): Promise<string | undefined> {
  try {
    const url = `https://api.github.com/repos/${ owner }/${ repo }/releases/tags/${ tag }`;
    const resp = await net.fetch(url, { headers: { Accept: 'application/vnd.github.v3+json' } });

    if (!resp.ok) {
      return undefined;
    }
    const data = await resp.json() as { body?: string };

    return data.body || undefined;
  } catch (err) {
    console.warn('[lightweightCheck] release notes fetch failed:', err);

    return undefined;
  }
}

/**
 * Perform a lightweight update check. Always works, regardless of whether the
 * app is packaged or not.
 */
export async function performLightweightCheck(): Promise<LightweightCheckResult> {
  const currentVersion = app.getVersion();
  const config = await resolveUpdateConfig();

  if (!config?.upgradeServer) {
    throw new Error('No upgrade server configured. Set RD_UPGRADE_RESPONDER_URL or provide dev-app-update.yml.');
  }

  const semverCurrent = new semver.SemVer(currentVersion);
  const result = await queryUpgradeResponder(config.upgradeServer, semverCurrent);
  const latestName = result.latest.Name.replace(/^v/, '');
  const latestSemver = semver.coerce(latestName);
  const updateAvailable = latestSemver ? semver.gt(latestSemver, semverCurrent) : false;

  let releaseNotes: string | undefined;

  if (updateAvailable && config.owner && config.repo) {
    const tag = (config.vPrefixedTagName === false ? '' : 'v') + latestName;

    releaseNotes = await fetchReleaseNotes(config.owner, config.repo, tag);
  }

  const releaseDateRaw = result.latest.ReleaseDate as Date | string | undefined;
  let releaseDate: string | undefined;

  if (releaseDateRaw) {
    releaseDate = typeof releaseDateRaw === 'string'
      ? releaseDateRaw
      : releaseDateRaw.toISOString();
  }

  return {
    updateAvailable,
    currentVersion,
    latestVersion:              latestName,
    releaseDate,
    releaseNotes,
    unsupportedUpdateAvailable: result.unsupportedUpdateAvailable,
    responderUrl:               config.upgradeServer,
  };
}
