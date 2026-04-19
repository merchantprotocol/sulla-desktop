/**
 * Audio device enumeration utility.
 *
 * Mic capture is handled by MicrophoneDriverController (tray panel renderer).
 * This module only provides device listing for the capture studio's
 * device selector dropdown.
 */

/**
 * List available audio input/output devices.
 * Filters out internal loopback/mirror devices.
 */
export async function listAudioDevices(): Promise<{
  inputs:  { deviceId: string; label: string }[];
  outputs: { deviceId: string; label: string }[];
}> {
  // Trigger permission prompt so labels are populated
  let tempStream: MediaStream | null = null;
  try {
    tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    // Permission denied — labels will be empty
  }

  let devices: MediaDeviceInfo[];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (e) {
    if (tempStream) {
      tempStream.getTracks().forEach(t => t.stop());
    }
    throw e;
  }

  if (tempStream) {
    tempStream.getTracks().forEach(t => t.stop());
  }

  const isInternal = (label: string) => /blackhole|loopback|audio driver mirror/i.test(label);

  const inputs = devices
    .filter(d => d.kind === 'audioinput' && d.deviceId && !isInternal(d.label))
    .map(d => ({ deviceId: d.deviceId, label: d.label || `Input (${ d.deviceId.slice(0, 8) })` }));

  const outputs = devices
    .filter(d => d.kind === 'audiooutput' && d.deviceId && !isInternal(d.label))
    .map(d => ({ deviceId: d.deviceId, label: d.label || `Output (${ d.deviceId.slice(0, 8) })` }));

  return { inputs, outputs };
}
