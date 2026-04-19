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
  id:               string;
  name:             string;
  thumbnailDataUrl: string;
}

export type QualityPreset = '480p' | '720p' | '1080p' | '4k' | 'auto';

export interface QualityConfig {
  label:     string;
  width:     number;
  height:    number;
  frameRate: number;
}

export const QUALITY_PRESETS: Record<Exclude<QualityPreset, 'auto'>, QualityConfig> = {
  '480p':  { label: '480p (SD)', width: 854, height: 480, frameRate: 30 },
  '720p':  { label: '720p (HD)', width: 1280, height: 720, frameRate: 30 },
  '1080p': { label: '1080p (Full HD)', width: 1920, height: 1080, frameRate: 30 },
  '4k':    { label: '4K (Ultra HD)', width: 3840, height: 2160, frameRate: 30 },
};

export function useMediaSources() {
  const screenStream: Ref<MediaStream | null> = ref(null);
  const cameraStream: Ref<MediaStream | null> = ref(null);
  const activeScreenName = ref('');
  const activeScreenSourceId = ref('');
  const activeCameraName = ref('');
  const activeCameraDeviceId = ref('');
  const screenQuality: Ref<QualityPreset> = ref('auto');
  const cameraQuality: Ref<QualityPreset> = ref('720p');

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

    let stream: MediaStream;
    try {
      // Use Electron's chromeMediaSource constraint to capture a specific source.
      // Screen capture always acquires at native resolution — quality preset
      // only controls recording bitrate (see useRecorder).  Electron's
      // desktopCapturer mandatory block does not support resolution constraints.
      stream = await (navigator.mediaDevices as any).getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource:   'desktop',
            chromeMediaSourceId: sourceId,
          },
        },
      });
    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
        throw new Error('Screen capture permission denied. Please enable screen recording in System Preferences.');
      }
      throw err;
    }

    // Verify the stream has tracks
    if (!stream || stream.getVideoTracks().length === 0) {
      throw new Error('Screen capture returned no video tracks');
    }

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

    const videoConstraint: MediaTrackConstraints | boolean =
      deviceId ? { deviceId: { exact: deviceId } } : {};

    // Apply quality constraints for camera (unless 'auto' = device default)
    if (cameraQuality.value !== 'auto' && typeof videoConstraint === 'object') {
      const preset = QUALITY_PRESETS[cameraQuality.value];
      videoConstraint.width = { ideal: preset.width };
      videoConstraint.height = { ideal: preset.height };
      videoConstraint.frameRate = { ideal: preset.frameRate };
    }

    const constraints: MediaStreamConstraints = {
      video: Object.keys(videoConstraint as object).length > 0 ? videoConstraint : true,
      audio: false,
    };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
        throw new Error('Camera permission denied. Please enable camera access in System Preferences.');
      }
      throw err;
    }

    // Verify the stream has tracks
    if (!stream || stream.getVideoTracks().length === 0) {
      throw new Error('Camera capture returned no video tracks');
    }

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
   * Change screen quality preset.
   * Screen capture always runs at native resolution — this only affects
   * the recording bitrate in useRecorder.
   */
  async function setScreenQuality(preset: QualityPreset): Promise<void> {
    screenQuality.value = preset;
  }

  /**
   * Change camera quality.  Applies constraints to the live track when
   * possible so the feed never drops.  Falls back to re-acquire if
   * applyConstraints isn't supported or fails.
   */
  async function setCameraQuality(preset: QualityPreset): Promise<void> {
    cameraQuality.value = preset;
    if (!cameraStream.value) return;

    const track = cameraStream.value.getVideoTracks()[0];
    if (!track) return;

    if (preset === 'auto') {
      // Remove resolution/framerate constraints — revert to device defaults
      try {
        await track.applyConstraints({
          width:     {},
          height:    {},
          frameRate: {},
        });
        console.log('[useMediaSources] Camera quality → auto (constraints cleared)');
        return;
      } catch (e: any) {
        console.warn('[useMediaSources] applyConstraints(auto) failed, re-acquiring:', e.message);
      }
    } else {
      const cfg = QUALITY_PRESETS[preset];
      try {
        await track.applyConstraints({
          width:     { ideal: cfg.width },
          height:    { ideal: cfg.height },
          frameRate: { ideal: cfg.frameRate },
        });
        console.log(`[useMediaSources] Camera quality → ${ preset } via applyConstraints`);
        return;
      } catch (e: any) {
        console.warn('[useMediaSources] applyConstraints failed, re-acquiring:', e.message);
      }
    }

    // Fallback: full re-acquire (saves deviceId before release clears it)
    const deviceId = activeCameraDeviceId.value || undefined;
    try {
      await acquireCamera(deviceId);
    } catch (e: any) {
      console.error('[useMediaSources] Camera re-acquire failed:', e.message);
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
  async function listVideoDevices(): Promise<{ deviceId: string; label: string }[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter(d => d.kind === 'videoinput' && d.deviceId)
      .map(d => ({ deviceId: d.deviceId, label: d.label || `Camera (${ d.deviceId.slice(0, 8) })` }));
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
    screenQuality,
    cameraQuality,
    acquireScreen,
    switchScreen,
    releaseScreen,
    acquireCamera,
    switchCamera,
    releaseCamera,
    setScreenQuality,
    setCameraQuality,
    listScreenSources,
    listVideoDevices,
  };
}
