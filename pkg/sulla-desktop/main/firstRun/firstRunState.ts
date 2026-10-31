// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.

import fs from 'node:fs';
import path from 'node:path';

import Electron from 'electron';

export type FirstRunState = {
  version: 1;
  step: number;
  onboardingComplete: boolean;
  /**
   * False from the moment the wizard reaches Finishing until the Cloud
   * session first run held in memory is safely in the vault. Absent on
   * installs that finished before this field existed.
   */
  credentialsSaved?: boolean;
  choices: Record<string, unknown>;
};

/** Index of the last wizard screen ("Finishing"); see stepNames in pages/FirstRun.vue. */
export const FIRST_RUN_LAST_STEP = 3;

export type FirstRunStateFileStatus = 'ok' | 'missing' | 'corrupt';

const initialState: FirstRunState = {
  version: 1,
  step: 0,
  onboardingComplete: false,
  choices: {},
};

// Main is the only writer. Keeping the last state in memory means a failed
// disk write never loses what the user just did in this session.
let cached: FirstRunState | undefined;
// What the first disk read found. Later reads use the cache, so a corrupt
// file that was moved aside still reads as 'corrupt', not 'missing'.
let fileStatus: FirstRunStateFileStatus | undefined;

function statePath(): string {
  return path.join(Electron.app.getPath('userData'), 'first-run-state.json');
}

function normalize(value: unknown): FirstRunState {
  if (!value || typeof value !== 'object') return { ...initialState, choices: {} };
  const candidate = value as Partial<FirstRunState>;
  const step = Number.isInteger(candidate.step) ? candidate.step as number : 0;
  const state: FirstRunState = {
    version: 1,
    step: Math.min(Math.max(step, 0), FIRST_RUN_LAST_STEP),
    onboardingComplete: candidate.onboardingComplete === true,
    choices: candidate.choices && typeof candidate.choices === 'object' && !Array.isArray(candidate.choices) ? candidate.choices : {},
  };

  if (typeof candidate.credentialsSaved === 'boolean') state.credentialsSaved = candidate.credentialsSaved;

  return state;
}

/**
 * Read the state file and say whether it was there. A corrupt file is kept
 * aside for diagnosis and reported as 'corrupt', never as a finished setup.
 */
export function readFirstRunStateFile(): { state: FirstRunState; status: FirstRunStateFileStatus } {
  if (cached && fileStatus) return { state: cached, status: fileStatus };
  const target = statePath();

  try {
    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SyntaxError('first-run state is not an object');
    cached = normalize(raw);
    fileStatus = 'ok';
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      // Nothing to cache yet: the file may appear once the wizard opens.
      return { state: { ...initialState, choices: {} }, status: 'missing' };
    }
    console.warn('[FirstRunState] Could not read state; setup will run again:', err);
    try {
      fs.renameSync(target, `${ target }.corrupt`);
    } catch { /* best effort */ }
    cached = { ...initialState, choices: {} };
    fileStatus = 'corrupt';
  }

  return { state: cached, status: fileStatus };
}

export function getFirstRunState(): FirstRunState {
  if (cached) return { ...cached, choices: { ...cached.choices } };
  const { state } = readFirstRunStateFile();

  return { ...state, choices: { ...state.choices } };
}

/**
 * Apply a patch in memory, then write it best effort. A write failure is
 * logged, not thrown: the wizard keeps going and the next write retries.
 */
export function updateFirstRunState(patch: Partial<Omit<FirstRunState, 'version'>>): FirstRunState {
  const current = getFirstRunState();
  const next = normalize({ ...current, ...patch, version: 1 });
  const target = statePath();
  const temporary = `${ target }.tmp`;

  cached = next;
  fileStatus ??= 'ok';
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, `${ JSON.stringify(next, null, 2) }\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (err) {
    console.warn('[FirstRunState] Could not save state; keeping it in memory:', err);
  }

  return { ...next, choices: { ...next.choices } };
}
