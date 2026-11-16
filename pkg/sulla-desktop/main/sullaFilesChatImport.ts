// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import path from 'node:path';

import { dialog, type BrowserWindow } from 'electron';

import { ChatFilesImporter } from './ChatFilesImporter';
import { ChatFilesSourceGuard } from './ChatFilesSourceGuard';
import { getSullaFilesClient } from './sullaFilesClient';

import paths from '@pkg/utils/paths';

import type { ChatFilesReference, PartialChatFilesImport } from './ChatFilesImporter';

export type { ChatFilesReference, PartialChatFilesImport } from './ChatFilesImporter';

/** Binds the one main-process ChatFilesImporter to the Files client, host paths and Electron dialog. */
export class ChatFilesImporterProvider {
  private instance?:ChatFilesImporter;

  constructor(
    private readonly factory:() => ChatFilesImporter = () => new ChatFilesImporter(
      getSullaFilesClient(),
      new ChatFilesSourceGuard(() => [
        paths.appHome,
        paths.altAppHome,
        paths.sullaConfig,
        path.join(paths.sullaHome, 'integrations'),
        path.join(paths.sullaHome, 'private-files-quarantine'),
      ]),
      dialog,
    ),
  ) {}

  resolve():ChatFilesImporter {
    return this.instance ??= this.factory();
  }
}

export const chatFilesImporterProvider = new ChatFilesImporterProvider();

/** Compatibility delegators for sullaFilesIpc.ts and sullaFilesCapture.ts. */
export async function importChatFiles(filePaths:string[], destination = ''):Promise<ChatFilesReference[] | PartialChatFilesImport> {
  return chatFilesImporterProvider.resolve().import(filePaths, destination);
}

export async function pickAndImportChatFiles(owner?:BrowserWindow):Promise<ChatFilesReference[] | PartialChatFilesImport> {
  return chatFilesImporterProvider.resolve().pickAndImport(owner);
}
