/**
 * Composable — screen and camera capture via browser media APIs.
 *
 * Permissions are pre-granted in background.ts (setPermissionCheckHandler).
 * getDisplayMedia is configured with audio: 'loopback' for system audio.
 */

import { ref, onUnmounted, type Ref } from 'vue';

export function useMediaSources() {
  const screenStream: Ref<MediaStream | null> = ref(null);
  const cameraStream: Ref<MediaStream | null> = ref(null);

  /**
   * Acquire screen capture. Returns a MediaStream with video + system audio tracks.
   * The system audio track can be extracted via stream.getAudioTracks().
   */
  async function acquireScreen(): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
    screenStream.value = stream;

    // Clean up ref if user stops sharing via browser UI
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      screenStream.value = null;
    });

    return stream;
  }

  function releaseScreen() {
    if (screenStream.value) {
      screenStream.value.getTracks().forEach(t => t.stop());
      screenStream.value = null;
    }
  }

  /**
   * Acquire camera capture.
   */
  async function acquireCamera(deviceId?: string): Promise<MediaStream> {
    const constraints: MediaStreamConstraints = {
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
      audio: false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    cameraStream.value = stream;
    return stream;
  }

  function releaseCamera() {
    if (cameraStream.value) {
      cameraStream.value.getTracks().forEach(t => t.stop());
      cameraStream.value = null;
    }
  }

  /**
   * List available video input devices (cameras).
   */
  async function listVideoDevices(): Promise<Array<{ deviceId: string; label: string }>> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter(d => d.kind === 'videoinput' && d.deviceId)
      .map(d => ({ deviceId: d.deviceId, label: d.label || `Camera (${d.deviceId.slice(0, 8)})` }));
  }

  onUnmounted(() => {
    releaseScreen();
    releaseCamera();
  });

  return {
    screenStream,
    cameraStream,
    acquireScreen,
    releaseScreen,
    acquireCamera,
    releaseCamera,
    listVideoDevices,
  };
}
