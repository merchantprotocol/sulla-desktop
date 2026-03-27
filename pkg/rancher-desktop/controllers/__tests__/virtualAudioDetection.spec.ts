import {
  findVirtualAudioDevice,
  isVirtualAudioDevice,
  VIRTUAL_DEVICE_PATTERNS,
} from '../virtualAudioDetection';

/** Helper to create a fake MediaDeviceInfo */
function fakeDevice(kind: MediaDeviceInfo['kind'], label: string, deviceId = 'test-id'): MediaDeviceInfo {
  return { kind, label, deviceId, groupId: '', toJSON: () => ({}) } as MediaDeviceInfo;
}

describe('VIRTUAL_DEVICE_PATTERNS', () => {
  const positives = [
    'ZoomAudioDevice',
    'Zoom Audio Device',
    'zoom audio',
    'BlackHole 2ch',
    'BlackHole 16ch',
    'blackhole',
    'Loopback Audio',
    'Soundflower (2ch)',
    'soundflower',
    'Virtual Audio Cable',
    'VB-Cable',
    'vb-cable',
    'Sulla Audio Device',
    'sulla-audio',
  ];

  const negatives = [
    'MacBook Air Microphone',
    'MacBook Air Speakers',
    'Microsoft Teams Audio',
    'AirPods Pro',
    'Built-in Microphone',
    'External USB Microphone',
    'Bluetooth Headset',
    '',
  ];

  it.each(positives)('matches virtual device: "%s"', (label) => {
    expect(isVirtualAudioDevice(label)).toBe(true);
  });

  it.each(negatives)('does not match non-virtual device: "%s"', (label) => {
    expect(isVirtualAudioDevice(label)).toBe(false);
  });
});

describe('findVirtualAudioDevice', () => {
  it('returns first matching virtual audio input device', () => {
    const devices = [
      fakeDevice('audioinput', 'MacBook Air Microphone', 'mic-1'),
      fakeDevice('audioinput', 'ZoomAudioDevice', 'zoom-1'),
      fakeDevice('audioinput', 'BlackHole 2ch', 'bh-1'),
      fakeDevice('audiooutput', 'MacBook Air Speakers', 'spk-1'),
    ];

    const result = findVirtualAudioDevice(devices);
    expect(result).not.toBeNull();
    expect(result!.deviceId).toBe('zoom-1');
    expect(result!.label).toBe('ZoomAudioDevice');
  });

  it('returns null when no virtual device is present', () => {
    const devices = [
      fakeDevice('audioinput', 'MacBook Air Microphone', 'mic-1'),
      fakeDevice('audioinput', 'External USB Mic', 'usb-1'),
      fakeDevice('audiooutput', 'MacBook Air Speakers', 'spk-1'),
    ];

    expect(findVirtualAudioDevice(devices)).toBeNull();
  });

  it('ignores audio output devices even if label matches', () => {
    const devices = [
      fakeDevice('audiooutput', 'BlackHole 2ch', 'bh-out'),
      fakeDevice('videoinput', 'ZoomAudioDevice', 'zoom-vid'),
    ];

    expect(findVirtualAudioDevice(devices)).toBeNull();
  });

  it('returns null for empty device list', () => {
    expect(findVirtualAudioDevice([])).toBeNull();
  });

  it('handles devices with no label', () => {
    const devices = [
      fakeDevice('audioinput', '', 'no-label'),
    ];

    expect(findVirtualAudioDevice(devices)).toBeNull();
  });

  it('matches case-insensitively', () => {
    const devices = [
      fakeDevice('audioinput', 'BLACKHOLE 2CH', 'bh-upper'),
    ];

    const result = findVirtualAudioDevice(devices);
    expect(result).not.toBeNull();
    expect(result!.deviceId).toBe('bh-upper');
  });

  it('supports custom patterns', () => {
    const customPatterns = [/my-custom-device/i];
    const devices = [
      fakeDevice('audioinput', 'My-Custom-Device', 'custom-1'),
      fakeDevice('audioinput', 'ZoomAudioDevice', 'zoom-1'),
    ];

    const result = findVirtualAudioDevice(devices, customPatterns);
    expect(result).not.toBeNull();
    expect(result!.deviceId).toBe('custom-1');
  });

  it('prefers first match in device order', () => {
    const devices = [
      fakeDevice('audioinput', 'BlackHole 2ch', 'bh-1'),
      fakeDevice('audioinput', 'ZoomAudioDevice', 'zoom-1'),
    ];

    const result = findVirtualAudioDevice(devices);
    expect(result!.deviceId).toBe('bh-1');
  });

  it('simulates real macOS device list', () => {
    // Actual devices from user's MacBook
    const devices = [
      fakeDevice('audioinput', 'MacBook Air Microphone', 'built-in-mic'),
      fakeDevice('audiooutput', 'MacBook Air Speakers', 'built-in-spk'),
      fakeDevice('audioinput', 'Microsoft Teams Audio', 'teams-audio'),
      fakeDevice('audioinput', 'ZoomAudioDevice', 'zoom-audio-dev'),
    ];

    const result = findVirtualAudioDevice(devices);
    expect(result).not.toBeNull();
    expect(result!.label).toBe('ZoomAudioDevice');
    expect(result!.deviceId).toBe('zoom-audio-dev');
  });
});
