// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';
import semver from 'semver';

export type UpdateChannel = 'lts' | 'nightly';
export type UpdateChannelSetter = 'user' | string;
export interface UpdateChannelState {
  version: 1;
  channel: UpdateChannel;
  pinnedVersion?: string;
  setBy: UpdateChannelSetter;
  setAt: string;
  pendingInstall?: { previousVersion: string; targetVersion: string; channel: UpdateChannel; verifiedAt: string };
  lastUpdateResult?: { previousVersion: string; newVersion: string; channel: UpdateChannel; completedAt: string };
}

export const UPDATE_CHANNEL_STATE_FILE = 'update-channel.json';

function initialState(): UpdateChannelState {
  return { version: 1, channel: 'lts', setBy: 'user', setAt: new Date(0).toISOString() };
}

function filePath(): string { return path.join(app.getPath('userData'), UPDATE_CHANNEL_STATE_FILE) }

export function readUpdateChannelState(): UpdateChannelState {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8')) as Partial<UpdateChannelState>;
    const channel = parsed.channel === 'nightly' ? 'nightly' : 'lts';
    return { ...initialState(), ...parsed, version: 1, channel };
  } catch { return initialState() }
}

export function writeUpdateChannelState(state: UpdateChannelState): void {
  const target = filePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${ target }.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function setUpdateChannel(channel: UpdateChannel, options: { pinnedVersion?: string; setBy: UpdateChannelSetter }): UpdateChannelState {
  const pinnedVersion = options.pinnedVersion?.trim();
  if (pinnedVersion && !semver.valid(pinnedVersion)) throw new Error('pinnedVersion must be valid semver.');
  if (!options.setBy || (options.setBy !== 'user' && options.setBy.length > 160)) throw new Error('setBy must be user or a support session id.');
  const state = readUpdateChannelState();
  const next: UpdateChannelState = {
    ...state, channel, setBy: options.setBy, setAt: new Date().toISOString(),
    ...(pinnedVersion ? { pinnedVersion } : { pinnedVersion: undefined }),
  };
  writeUpdateChannelState(next);
  return next;
}

export function recordPendingUpdate(targetVersion: string): void {
  const state = readUpdateChannelState();
  state.pendingInstall = {
    previousVersion: app.getVersion(), targetVersion, channel: state.channel, verifiedAt: new Date().toISOString(),
  };
  writeUpdateChannelState(state);
}

export function reconcileCompletedUpdate(): UpdateChannelState {
  const state = readUpdateChannelState();
  if (state.pendingInstall && state.pendingInstall.previousVersion !== app.getVersion()) {
    state.lastUpdateResult = {
      previousVersion: state.pendingInstall.previousVersion,
      newVersion: app.getVersion(),
      channel: state.pendingInstall.channel,
      completedAt: new Date().toISOString(),
    };
    delete state.pendingInstall;
    writeUpdateChannelState(state);
  }
  return state;
}
