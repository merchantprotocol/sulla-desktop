// SPDX-License-Identifier: GPL-2.0-or-later
import type { DockerClient } from '@pkg/utils/dockerClient';

declare global {
  interface Window {
    ddClient: DockerClient;
  }
}
