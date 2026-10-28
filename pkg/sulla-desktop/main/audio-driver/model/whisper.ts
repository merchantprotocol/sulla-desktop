// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Model — whisper.cpp detection and management.
 * Thin wrapper around the platform provider with caching.
 *
 * Mirrors the loopback model pattern: detect → cache → expose status.
 */

import path from 'path';

import * as platform from '../platform';

interface WhisperStatus {
  available:   boolean;
  version?:    string;
  binaryPath?: string;
  modelsPath?: string;
  models?:     string[];
}

let cachedStatus: WhisperStatus | null = null;

export async function detect(): Promise<WhisperStatus> {
  const result = await platform.whisper.detect();

  cachedStatus = result;
  return result;
}

export function getStatus(): WhisperStatus | null {
  return cachedStatus;
}

export function isAvailable(): boolean {
  return cachedStatus?.available === true;
}

export async function install(onProgress?: (line: string) => void): Promise<{ ok: boolean; error?: string }> {
  return platform.whisper.install(onProgress);
}

export async function remove(onProgress?: (line: string) => void): Promise<void> {
  return platform.whisper.remove(onProgress);
}

/**
 * Download a specific Whisper model (e.g. 'base', 'base.en', 'small', 'medium', 'large').
 * Models are stored in the platform-specific models directory.
 */
export async function downloadModel(model: string, onProgress?: (pct: number, status: string) => void): Promise<boolean> {
  return platform.whisper.downloadModel(model, onProgress);
}

/** Path of a model's file: a downloaded copy, else the one bundled with the app. */
export function modelPath(model: string): string | undefined {
  if (typeof platform.whisper.modelPath === 'function') return platform.whisper.modelPath(model);
  const modelsPath = cachedStatus?.modelsPath;

  return modelsPath ? path.join(modelsPath, `ggml-${ model }.bin`) : undefined;
}

export function getModels(): string[] {
  return cachedStatus?.models ?? [];
}
