/**
 * Composable — screen and camera capture via browser media APIs.
 *
 * Permissions are pre-granted in background.ts (setPermissionCheckHandler).
 * getDisplayMedia is configured with audio: 'loopback' for system audio.
 *
 * Supports source switching: right-click to pick a different screen or camera.
 */

import { ref, onUnmounted, type Ref } from 'vue';

const { ipcRenderer } = require('electron');

export interface ScreenSource {
  id: string;
  name: string;
  thumbnailDataUrl: string;
}

export function useMediaSources() {
  const screenStream: Ref<MediaStream | null> = ref(null);
  const cameraStream: Ref<MediaStream | null> = ref(null);
  const activeScreenName = ref('');
  const activeCameraName = ref('');
  const activeCameraDeviceId = ref('');

  /**
   * Acquire screen capture. Returns a MediaStream with video + system audio tracks.
   */
  async function acquireScreen(): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
    screenStream.value = stream;

    // Try to get the screen name from the track label
    const videoTrack = stream.getVideoTracks()[0];
    activeScreenName.value = videoTrack?.label || 'Screen';

    // Clean up ref if user stops sharing via browser UI
    videoTrack?.addEventListener('ended', () => {
      screenStream.value = null;
      activeScreenName.value = '';
    });

    return stream;
  }

  /**
   * Switch to a specific screen/window source by its desktopCapturer source id.
   */
  async function switchScreen(sourceId: string): Promise<MediaStream> {
    // Stop current screen capture
    releaseScreen();

    // Use Electron's desktopCapturer constraints to pick a specific source
    const stream = await (navigator.mediaDevices as any).getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
        },
      },
    });

    screenStream.value = stream;
    const videoTrack = stream.getVideoTracks()[0];
    activeScreenName.value = videoTrack?.label || 'Screen';

    videoTrack?.addEventListener('ended', () => {
      screenStream.value = null;
      activeScreenName.value = '';
    });

    return stream;
  }

  function releaseScreen() {
    if (screenStream.value) {
      screenStream.value.getTracks().forEach(t => t.stop());
      screenStream.value = null;
      activeScreenName.value = '';
    }
  }

  /**
   * Acquire camera capture.
   */
  async function acquireCamera(deviceId?: string): Promise<MediaStream> {
    // Stop existing camera first
    releaseCamera();

    const constraints: MediaStreamConstraints = {
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
      audio: false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    cameraStream.value = stream;

    // Get the actual device name
    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings();
    activeCameraDeviceId.value = settings?.deviceId || deviceId || '';

    // Look up device label
    const devices = await navigator.mediaDevices.enumerateDevices();
    const device = devices.find(d => d.deviceId === activeCameraDeviceId.value);
    activeCameraName.value = device?.label || track?.label || 'Camera';

    track?.addEventListener('ended', () => {
      cameraStream.value = null;
      activeCameraName.value = '';
      activeCameraDeviceId.value = '';
    });

    return stream;
  }

  /**
   * Switch camera to a different device.
   */
  async function switchCamera(deviceId: string): Promise<MediaStream> {
    return acquireCamera(deviceId);
  }

  function releaseCamera() {
    if (cameraStream.value) {
      cameraStream.value.getTracks().forEach(t => t.stop());
      cameraStream.value = null;
      activeCameraName.value = '';
      activeCameraDeviceId.value = '';
    }
  }

  /**
   * List available screen/window sources via Electron's desktopCapturer.
   */
  async function listScreenSources(): Promise<ScreenSource[]> {
    const sources = await ipcRenderer.invoke('capture-studio:get-sources');
    return sources;
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
    activeScreenName,
    activeCameraName,
    activeCameraDeviceId,
    acquireScreen,
    switchScreen,
    releaseScreen,
    acquireCamera,
    switchCamera,
    releaseCamera,
    listScreenSources,
    listVideoDevices,
  };
}
