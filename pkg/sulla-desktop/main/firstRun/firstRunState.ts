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
  choices: Record<string, unknown>;
};

const initialState: FirstRunState = {
  version: 1,
  step: 0,
  onboardingComplete: false,
  choices: {},
};

function statePath(): string {
  return path.join(Electron.app.getPath('userData'), 'first-run-state.json');
}

function normalize(value: unknown): FirstRunState {
  if (!value || typeof value !== 'object') return { ...initialState, choices: {} };
  const candidate = value as Partial<FirstRunState>;

  return {
    version: 1,
    step: Number.isInteger(candidate.step) && (candidate.step as number) >= 0 ? candidate.step as number : 0,
    onboardingComplete: candidate.onboardingComplete === true,
    choices: candidate.choices && typeof candidate.choices === 'object' && !Array.isArray(candidate.choices) ? candidate.choices : {},
  };
}

export function getFirstRunState(): FirstRunState {
  try {
    return normalize(JSON.parse(fs.readFileSync(statePath(), 'utf8')));
  } catch (err: any) {
    if (err?.code !== 'ENOENT') console.warn('[FirstRunState] Could not read state; using defaults:', err);

    return { ...initialState, choices: {} };
  }
}

export function updateFirstRunState(patch: Partial<Omit<FirstRunState, 'version'>>): FirstRunState {
  const current = getFirstRunState();
  const next = normalize({ ...current, ...patch, version: 1 });
  const target = statePath();
  const temporary = `${ target }.tmp`;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, `${ JSON.stringify(next, null, 2) }\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);

  return next;
}
