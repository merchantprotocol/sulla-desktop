/**
 * Composable — screen and camera capture via Electron desktopCapturer + getUserMedia.
 *
 * Screen capture uses desktopCapturer (no browser picker popup).
 * System audio comes from the audio-driver speaker socket, NOT from getDisplayMedia.
 * Camera capture uses standard getUserMedia.
 *
 * Supports source switching via right-click context menus.
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
  const activeScreenSourceId = ref('');
  const activeCameraName = ref('');
  const activeCameraDeviceId = ref('');

  /**
   * Acquire a specific screen/window source via desktopCapturer.
   * If no sourceId is given, picks the first available screen.
   */
  async function acquireScreen(sourceId?: string): Promise<MediaStream> {
    releaseScreen();

    // If no source specified, pick the first screen
    if (!sourceId) {
      const sources = await listScreenSources();
      const firstScreen = sources.find(s => s.name.toLowerCase().includes('screen')) || sources[0];
      if (!firstScreen) throw new Error('No screen sources available');
      sourceId = firstScreen.id;
    }

    // Use Electron's chromeMediaSource constraint to capture a specific source
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
    activeScreenSourceId.value = sourceId;

    const videoTrack = stream.getVideoTracks()[0];
    activeScreenName.value = videoTrack?.label || 'Screen';

    videoTrack?.addEventListener('ended', () => {
      screenStream.value = null;
      activeScreenName.value = '';
      activeScreenSourceId.value = '';
    });

    return stream;
  }

  /**
   * Switch to a different screen source.
   */
  async function switchScreen(sourceId: string): Promise<MediaStream> {
    return acquireScreen(sourceId);
  }

  function releaseScreen() {
    if (screenStream.value) {
      screenStream.value.getTracks().forEach(t => t.stop());
      screenStream.value = null;
      activeScreenName.value = '';
      activeScreenSourceId.value = '';
    }
  }

  /**
   * Acquire camera capture.
   */
  async function acquireCamera(deviceId?: string): Promise<MediaStream> {
    releaseCamera();

    const constraints: MediaStreamConstraints = {
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
      audio: false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    cameraStream.value = stream;

    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings();
    activeCameraDeviceId.value = settings?.deviceId || deviceId || '';

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
    return ipcRenderer.invoke('capture-studio:get-sources');
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
    activeScreenSourceId,
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
