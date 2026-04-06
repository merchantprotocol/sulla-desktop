/**
 * Model — whisper.cpp detection and management.
 * Thin wrapper around the platform provider with caching.
 *
 * Mirrors the loopback model pattern: detect → cache → expose status.
 */

import * as platform from '../platform';

interface WhisperStatus {
  available: boolean;
  version?: string;
  binaryPath?: string;
  modelsPath?: string;
  models?: string[];
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

export async function install(): Promise<boolean> {
  return platform.whisper.install();
}

export async function remove(): Promise<void> {
  return platform.whisper.remove();
}

/**
 * Download a specific Whisper model (e.g. 'base', 'base.en', 'small', 'medium', 'large').
 * Models are stored in the platform-specific models directory.
 */
export async function downloadModel(model: string): Promise<boolean> {
  return platform.whisper.downloadModel(model);
}

export function getModels(): string[] {
  return cachedStatus?.models ?? [];
}
