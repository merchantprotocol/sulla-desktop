// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Composable — screen and camera capture via Electron desktopCapturer + getUserMedia.
 *
 * Screen capture uses desktopCapturer (no browser picker popup).
 * System audio comes from the audio-driver speaker socket, NOT from getDisplayMedia.
 * Camera capture uses standard getUserMedia.
 *
 * Supports source switching via right-click context menus.
 */

import { ref, inject, reactive, type Ref } from 'vue';

import { cameraEffectsKey } from '../effects/CameraEffectsComposition';
import { CameraStreamService } from '../effects/CameraStreamService';
import { CameraStreamRegistry } from '../services/CameraStreamRegistry';
import { ScreenStreamRegistry } from '../services/ScreenStreamRegistry';

const { ipcRenderer } = require('electron');

export interface ScreenSource {
  id:               string;
  name:             string;
  thumbnailDataUrl: string;
}

export interface CropRegion { x: number; y: number; width: number; height: number }

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
  const screenStreams = reactive<Record<string, MediaStream>>({});
  const screenRegistry = new ScreenStreamRegistry();
  const cameraStream: Ref<MediaStream | null> = ref(null);
  const cameraStreams = reactive<Record<string, MediaStream>>({});
  const cameraDeviceIds = reactive<Record<string, string>>({});
  const activeScreenName = ref('');
  const activeScreenSourceId = ref('');
  const activeCameraName = ref('');
  const activeCameraDeviceId = ref('');
  const screenQuality: Ref<QualityPreset> = ref('auto');
  const cameraQuality: Ref<QualityPreset> = ref('720p');
  const cameraQualities = reactive<Record<string, QualityPreset>>({});
  const effects = inject(cameraEffectsKey);
  if (!effects) throw new Error('Capture Studio camera effects composition is missing');
  const cameraEffectError = ref('');
  const cameraEffectsRevision = ref(0);
  function createCameraService(sourceKey: string): CameraStreamService {
    return new CameraStreamService(effects!, constraints => navigator.mediaDevices.getUserMedia(constraints), stream => {
      if (stream) cameraStreams[sourceKey] = stream;
      else delete cameraStreams[sourceKey];
      if (sourceKey === 'cam') {
        cameraStream.value = stream;
        if (!stream) { activeCameraName.value = ''; activeCameraDeviceId.value = ''; }
      }
    }, error => {
      cameraEffectError.value = 'Camera effects unavailable. Original camera video is being used.';
      console.warn('[CameraEffects]', sourceKey, error);
    }, () => {
      if (sourceKey === 'cam') {
        const options = cameras.get('cam').effectOptions;
        if (options.autoFrame || options.soften || options.backgroundBlur) cameraEffectError.value = '';
      }
      cameraEffectsRevision.value++;
    });
  }
  const cameras = new CameraStreamRegistry(createCameraService);
  const camera = cameras.get('cam');
  function cameraForSource(sourceKey = 'cam'): CameraStreamService { return cameras.get(sourceKey); }
  const rawScreenStreams = new Map<string, MediaStream>();
  const cropTimers = new Map<string, ReturnType<typeof setInterval>>();

  /**
   * Acquire a specific screen/window source via desktopCapturer.
   * If no sourceId is given, picks the first available screen.
   */
  async function acquireScreen(sourceId?: string, crop?: CropRegion, sourceKey = 'screen'): Promise<MediaStream> {
    releaseScreen(sourceKey);

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

    const rawStream = stream;
    if (crop && crop.width > 0 && crop.height > 0) {
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(2, Math.round(video.videoWidth * crop.width));
      canvas.height = Math.max(2, Math.round(video.videoHeight * crop.height));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('Could not create the selected-area recorder');
      const draw = () => {
        context.drawImage(video,
          Math.round(video.videoWidth * crop.x), Math.round(video.videoHeight * crop.y),
          Math.round(video.videoWidth * crop.width), Math.round(video.videoHeight * crop.height),
          0, 0, canvas.width, canvas.height);
      };
      // A timer, not requestAnimationFrame: rAF stops while the studio window
      // is minimized or covered, which would freeze the recording.
      draw();
      cropTimers.set(sourceKey, setInterval(draw, 1000 / 30));
      stream = canvas.captureStream(30);
    }
    screenRegistry.set(sourceKey, stream);
    screenStreams[sourceKey] = stream;
    if (sourceKey === 'screen') screenStream.value = stream;
    rawScreenStreams.set(sourceKey, rawStream);
    if (sourceKey === 'screen') activeScreenSourceId.value = sourceId;

    const videoTrack = stream.getVideoTracks()[0];
    if (sourceKey === 'screen') activeScreenName.value = videoTrack?.label || 'Screen';

    videoTrack?.addEventListener('ended', () => {
      if (screenStreams[sourceKey] === stream) releaseScreen(sourceKey);
    });

    return stream;
  }

  /**
   * Switch to a different screen source.
   */
  async function switchScreen(sourceId: string): Promise<MediaStream> {
    return acquireScreen(sourceId);
  }

  async function acquireScreenForSource(sourceKey: string, sourceId: string, crop?: CropRegion): Promise<MediaStream> {
    return acquireScreen(sourceId, crop, sourceKey);
  }

  function releaseScreen(sourceKey = 'screen') {
    const cropTimer = cropTimers.get(sourceKey);
    if (cropTimer !== undefined) { clearInterval(cropTimer); cropTimers.delete(sourceKey); }
    const stream = screenStreams[sourceKey];
    screenRegistry.release(sourceKey);
    delete screenStreams[sourceKey];
    if (sourceKey === 'screen') {
      screenStream.value = null;
      activeScreenName.value = '';
      activeScreenSourceId.value = '';
    }
    const raw = rawScreenStreams.get(sourceKey);
    if (raw && raw !== stream) raw.getTracks().forEach(t => t.stop());
    rawScreenStreams.delete(sourceKey);
  }

  function releaseAllScreens() {
    for (const sourceKey of [...screenRegistry.entries().map(([key]) => key)]) releaseScreen(sourceKey);
  }

  /**
   * Acquire camera capture.
   */
  async function acquireCamera(deviceId?: string, sourceKey = 'cam'): Promise<MediaStream> {
    const sourceCamera = cameraForSource(sourceKey);
    sourceCamera.assertMutable();

    const videoConstraint: MediaTrackConstraints | boolean =
      deviceId ? { deviceId: { exact: deviceId } } : {};

    // Apply quality constraints for camera (unless 'auto' = device default)
    const sourceQuality = sourceKey === 'cam' ? cameraQuality.value : cameraQualities[sourceKey] || cameraQuality.value;
    if (sourceQuality !== 'auto' && typeof videoConstraint === 'object') {
      const preset = QUALITY_PRESETS[sourceQuality];
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
      stream = await sourceCamera.acquire(constraints);
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

    const raw = sourceCamera.rawStream;
    const track = raw?.getVideoTracks()[0];
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    if (sourceCamera.rawStream !== raw) return stream;
    cameraDeviceIds[sourceKey] = track?.getSettings().deviceId || deviceId || '';
    if (sourceKey === 'cam') {
      activeCameraDeviceId.value = cameraDeviceIds[sourceKey];
      const device = devices.find(d => d.deviceId === activeCameraDeviceId.value);
      activeCameraName.value = device?.label || track?.label || 'Camera';
    }

    return stream;
  }

  /**
   * Switch camera to a different device.
   */
  async function switchCamera(deviceId: string): Promise<MediaStream> {
    return acquireCamera(deviceId);
  }

  async function acquireCameraForSource(sourceKey: string, deviceId?: string): Promise<MediaStream> {
    return acquireCamera(deviceId, sourceKey);
  }

  async function switchCameraForSource(sourceKey: string, deviceId: string): Promise<MediaStream> {
    return acquireCamera(deviceId, sourceKey);
  }

  async function releaseCamera(sourceKey = 'cam'): Promise<void> {
    await cameraForSource(sourceKey).release();
    delete cameraDeviceIds[sourceKey];
  }
  function assertCameraMutable(sourceKey = 'cam'): void { cameraForSource(sourceKey).assertMutable(); }
  async function beginAllCameraRecordings(): Promise<void> {
    try { await Promise.all(cameras.values().map(service => service.beginRecording())); }
    catch (error) { endAllCameraRecordings(); throw error; }
  }
  function endAllCameraRecordings(): void { for (const service of cameras.values()) service.endRecording(); }
  async function releaseAllCameras(): Promise<void> { await cameras.disposeAll(); }

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
  async function setCameraQuality(preset: QualityPreset, sourceKey = 'cam'): Promise<void> {
    const sourceCamera = cameraForSource(sourceKey);
    sourceCamera.assertMutable();
    cameraQualities[sourceKey] = preset;
    if (sourceKey === 'cam') cameraQuality.value = preset;
    if (!cameraStreams[sourceKey]) return;

    const track = sourceCamera.rawStream?.getVideoTracks()[0];
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
    const deviceId = cameraDeviceIds[sourceKey] || undefined;
    try {
      await acquireCamera(deviceId, sourceKey);
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

  // Parent owns ordered recorder flush -> screen/camera release on teardown.

  return {
    cameraEffectError, cameraEffectsRevision,
    camera,
    cameraForSource,
    screenStream,
    screenStreams,
    cameraStream,
    cameraStreams,
    cameraDeviceIds,
    activeScreenName,
    activeScreenSourceId,
    activeCameraName,
    activeCameraDeviceId,
    screenQuality,
    cameraQuality,
    cameraQualities,
    acquireScreen,
    acquireScreenForSource,
    switchScreen,
    releaseScreen,
    releaseAllScreens,
    acquireCamera,
    acquireCameraForSource,
    switchCameraForSource,
    switchCamera,
    releaseCamera,
    assertCameraMutable,
    beginAllCameraRecordings,
    endAllCameraRecordings,
    releaseAllCameras,
    setScreenQuality,
    setCameraQuality,
    listScreenSources,
    listVideoDevices,
  };
}
