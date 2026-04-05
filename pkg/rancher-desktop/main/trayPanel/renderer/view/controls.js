/**
 * View — mute/volume icon controls.
 *
 * Pure DOM manipulation. Emits change events via callbacks.
 * Uses icon buttons (mute, vol down, vol up) instead of sliders.
 */

const STEP = 10; // Volume step per click (percentage)

function createControl(muteBtnId, volDownId, volUpId, labelId) {
  const muteBtn = document.getElementById(muteBtnId);
  const volDownBtn = document.getElementById(volDownId);
  const volUpBtn = document.getElementById(volUpId);
  const label = document.getElementById(labelId);

  let muted = false;
  let volume = 100;
  let onMuteChange = null;
  let onVolumeChange = null;

  function render() {
    muteBtn.classList.toggle("muted", muted);
    label.textContent = muted ? "—" : volume + "%";
  }

  muteBtn.addEventListener("click", () => {
    muted = !muted;
    render();
    if (onMuteChange) onMuteChange(muted);
  });

  let onVolDown = null;
  let onVolUp = null;

  volDownBtn.addEventListener("click", () => {
    volume = Math.max(0, volume - STEP);
    if (muted) muted = false;
    render();
    if (onVolDown) onVolDown(volume / 100);
    else if (onVolumeChange) onVolumeChange(volume / 100);
  });

  volUpBtn.addEventListener("click", () => {
    volume = Math.min(100, volume + STEP);
    if (muted) muted = false;
    render();
    if (onVolUp) onVolUp(volume / 100);
    else if (onVolumeChange) onVolumeChange(volume / 100);
  });

  render();

  return {
    onMute(fn) { onMuteChange = fn; },
    onVolume(fn) { onVolumeChange = fn; },
    onVolumeDown(fn) { onVolDown = fn; },
    onVolumeUp(fn) { onVolUp = fn; },
    isMuted() { return muted; },
    getVolume() { return volume / 100; },
    setMuted(m) { muted = m; render(); },
    setVolume(v) { volume = Math.round(v * 100); render(); },
  };
}

function createMicControl() {
  return createControl("mic-mute-btn", "mic-vol-down", "mic-vol-up", "mic-volume-label");
}

function createSpeakerControl() {
  return createControl("speaker-mute-btn", "speaker-vol-down", "speaker-vol-up", "speaker-volume-label");
}

module.exports = { createMicControl, createSpeakerControl };
