/**
 * View — status display, device selectors.
 *
 * Pure DOM manipulation. No business logic, no IPC.
 */

function renderState(state) {
  document.getElementById("audio-status-dot").className =
    "dot " + (state.running ? "running" : "off");
  document.getElementById("audio-status-text").textContent =
    state.message || (state.running ? "Running" : "Off");
  document.getElementById("audio-enabled-toggle").checked = state.running;

  document.querySelectorAll("#panel-audio .meter-section").forEach((s) => {
    s.classList.toggle("disabled", !state.running);
  });
}

/**
 * Populate a <select> with device options.
 * @param {string} selectId - DOM id of the select element
 * @param {Array<{deviceId: string, label: string}>} devices
 * @param {string|null} activeDeviceId - currently selected device
 */
function populateDeviceSelect(selectId, devices, activeDeviceId) {
  const select = document.getElementById(selectId);
  const currentValue = select.value;

  select.innerHTML = "";

  devices.forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label;
    if (d.deviceId === activeDeviceId || d.deviceId === currentValue) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });
}

/**
 * Register a change handler on a device select.
 */
function onDeviceChange(selectId, callback) {
  document.getElementById(selectId).addEventListener("change", (e) => {
    callback(e.target.value);
  });
}

module.exports = { renderState, populateDeviceSelect, onDeviceChange };
