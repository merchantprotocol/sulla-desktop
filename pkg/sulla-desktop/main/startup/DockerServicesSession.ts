// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import Logging from '@pkg/utils/logging';

const console = Logging.sulla;

/** Tracks whether Sulla's Docker Compose services were started this session. */
export class DockerServicesSession {
  private started = false;

  markStarted(): void {
    this.started = true;
  }

  /**
   * Stop the Sulla Docker Compose services. Only runs if they were started this
   * session AND the Docker daemon is reachable.
   */
  composeDown(): void {
    console.log(`[Shutdown] trySullaComposeDown called — sullaDockerServicesStarted=${ this.started }`);
    if (!this.started) {
      console.log('[Shutdown] Skipping compose down — services were not started this session');
      return;
    }
    if (!this.isDockerDaemonRunning()) {
      console.log('[Shutdown] Docker daemon not running, skipping compose down');
      return;
    }
    try {
      const composeFilePath = path.join(process.cwd(), 'pkg/sulla-desktop/assets/sulla-docker-compose.yaml');
      execSync(`docker-compose -f "${ composeFilePath }" down`, { cwd: process.cwd(), stdio: 'inherit', timeout: 30000 });
      console.log('[Shutdown] Docker containers stopped');
    } catch (err) {
      console.warn('[Shutdown] Docker compose down failed:', err);
    }
  }

  /** Check if the Docker daemon socket is reachable before attempting compose commands. */
  private isDockerDaemonRunning(): boolean {
    try {
      // Quick socket existence check first
      if (!fs.existsSync('/var/run/docker.sock')) {
        return false;
      }
      execSync('docker info', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
}
