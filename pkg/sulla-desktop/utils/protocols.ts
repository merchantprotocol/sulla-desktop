// Sulla Desktop · https://sulladesktop.com
// Portions Copyright SUSE LLC and the Rancher Desktop contributors, licensed under
// the Apache License 2.0 (LICENSES/Apache-2.0.txt).
// Modifications Copyright (c) 2025-2026 Merchant Protocol LLC, licensed under the
// GPL-2.0-or-later (LICENSE).
// "Sulla" is a trademark. See TRADEMARK.md.

import path from 'path';
import { URL, pathToFileURL } from 'url';

import Electron from 'electron';

import Latch from '@pkg/utils/latch';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';

const console = Logging['protocol-handler'];

/**
 * Create a URL that consists of a base combined with the provided path
 * @param relPath The destination path for the requested resource
 * @returns A file path or URL for the requested resource
 */
function redirectedUrl(relPath: string) {
  if (Electron.app.isPackaged) {
    return path.join(Electron.app.getAppPath(), 'dist', 'app', relPath);
  }

  // Dev build or E2E tests - serve from dist/app
  // Use SULLA_PROJECT_DIR env var when available; fall back to process.cwd()
  // wrapped in try-catch to avoid ENOENT when the cwd has been removed.
  let projectDir: string;

  if (process.env.SULLA_PROJECT_DIR) {
    projectDir = process.env.SULLA_PROJECT_DIR;
  } else {
    try {
      projectDir = process.cwd();
    } catch {
      projectDir = Electron.app.getAppPath();
    }
  }

  return path.join(projectDir, 'dist', 'app', relPath);
}

// Latch that is set when the app:// protocol handler has been registered.
// This is used to ensure that we don't attempt to open the window before we've
// done that, when the user attempts to open a second instance of the window.
export const protocolsRegistered = Latch();

/**
 * Set up protocol handler for app://
 * This is needed because in packaged builds we'll not be allowed to access
 * file:// URLs for our resources. Use the same app:// protocol for both dev and
 * production environments.
 */
function setupAppProtocolHandler() {
  Electron.protocol.handle(
    'app',
    (request) => {
      const relPath = new URL(request.url).pathname;
      const filePath = redirectedUrl(relPath);

      console.log('[app:// protocol] request.url:', request.url, '-> relPath:', relPath, '-> filePath:', filePath);

      return Electron.net.fetch(pathToFileURL(filePath).toString());
    });
}

/**
 * Set up protocol handler for x-sulla-extension://
 *
 * This handler serves files from installed extensions; the format is:
 * x-sulla-extension://<extension id>/...
 * Where the extension id is hex encoded (to avoid issues with slashes).
 */
function setupExtensionProtocolHandler() {
  const scheme = 'x-sulla-extension';

  if (!Electron.protocol.isProtocolHandled(scheme)) {
    Electron.protocol.handle(
      scheme,
      (request) => {
        const url = new URL(request.url);
        // Re-encoding the extension ID here also ensures it doesn't contain any
        // directory traversal etc. issues.
        const extensionID = Buffer.from(url.hostname, 'hex').toString('base64url');
        const resourcePath = path.normalize(url.pathname);
        const filepath = path.join(paths.extensionRoot, extensionID, resourcePath);

        return Electron.net.fetch(pathToFileURL(filepath).toString());
      });
  }
}

export function setupProtocolHandlers() {
  try {
    setupAppProtocolHandler();
    setupExtensionProtocolHandler();

    protocolsRegistered.resolve();
  } catch (ex) {
    console.error('Error registering protocol handlers:', ex);
  }
}
