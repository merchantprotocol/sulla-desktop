import type { DockerClient } from '@pkg/utils/dockerClient';

declare global {
  interface Window {
    ddClient: DockerClient;
  }
}
